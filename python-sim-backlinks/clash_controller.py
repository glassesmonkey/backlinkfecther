from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


DEFAULT_CLASH_API_URL = "http://127.0.0.1:9097"
DEFAULT_CLASH_SECRET = "809001"
DEFAULT_GROUP_PREFERENCES = (
    "GLOBAL",
    "Proxy",
    "PROXY",
    "🚀 节点选择",
    "节点选择",
    "代理",
)
BUILT_IN_EXCLUDED_NODE_NAMES = {"DIRECT", "REJECT", "GLOBAL"}
SWITCH_CONFIRM_TIMEOUT_SECONDS = 20.0
SWITCH_CONFIRM_POLL_SECONDS = 0.5
SWITCH_STABLE_SECONDS = 3.0


@dataclass(frozen=True)
class ClashConfig:
    enabled: bool = False
    api_url: str = DEFAULT_CLASH_API_URL
    secret: str = DEFAULT_CLASH_SECRET
    exclude_keywords: tuple[str, ...] = ()


@dataclass(frozen=True)
class ClashSwitchResult:
    group_name: str
    previous_node: str | None
    next_node: str


def parse_exclude_keywords(raw_text: str | None) -> tuple[str, ...]:
    if not raw_text:
        return ()

    separators = [",", "，", "\n", "|"]
    normalized = raw_text
    for separator in separators:
        normalized = normalized.replace(separator, " ")

    keywords: list[str] = []
    seen: set[str] = set()
    for part in normalized.split():
        keyword = part.strip()
        key = keyword.lower()
        if not keyword or key in seen:
            continue
        seen.add(key)
        keywords.append(keyword)
    return tuple(keywords)


class ClashNodeSwitcher:
    def __init__(
        self,
        config: ClashConfig,
        *,
        logger: Callable[[str], None] = print,
    ) -> None:
        self.config = config
        self.logger = logger

    def test_connection(self) -> str:
        proxies = self._load_proxies()
        group_name, group = self._choose_group(proxies)
        candidates = self._candidate_nodes(group)
        current = _string_or_none(group.get("now"))
        return (
            f"Clash connected. Group: {group_name}; "
            f"current node: {current or 'unknown'}; selectable nodes: {len(candidates)}"
        )

    def switch_to_next_node(self, reason: str) -> ClashSwitchResult:
        proxies = self._load_proxies()
        group_name, group = self._choose_group(proxies)
        candidates = self._candidate_nodes(group)
        if not candidates:
            raise RuntimeError("No usable Clash nodes were found after applying exclude keywords.")

        current = _string_or_none(group.get("now"))
        next_node = self._pick_next_node(candidates, current)
        self.logger(f"Clash switching node because Similarweb failed: {reason}")
        self._select_node(group_name, next_node)
        self._wait_until_node_selected(group_name, next_node)
        return ClashSwitchResult(
            group_name=group_name,
            previous_node=current,
            next_node=next_node,
        )

    def _load_proxies(self) -> dict[str, Any]:
        payload = self._request_json("GET", "/proxies")
        proxies = payload.get("proxies")
        if not isinstance(proxies, dict):
            raise RuntimeError("Clash /proxies response did not contain a proxies object.")
        return proxies

    def _choose_group(self, proxies: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        selectable_groups: list[tuple[str, dict[str, Any]]] = []
        for name, proxy in proxies.items():
            if not isinstance(proxy, dict):
                continue
            all_nodes = proxy.get("all")
            if isinstance(all_nodes, list) and all_nodes:
                selectable_groups.append((name, proxy))

        if not selectable_groups:
            raise RuntimeError("No selectable Clash proxy group was found.")

        for preferred_name in DEFAULT_GROUP_PREFERENCES:
            for name, group in selectable_groups:
                if name == preferred_name:
                    return name, group

        for name, group in selectable_groups:
            if self._candidate_nodes(group):
                return name, group

        return selectable_groups[0]

    def _candidate_nodes(self, group: dict[str, Any]) -> list[str]:
        raw_nodes = group.get("all")
        if not isinstance(raw_nodes, list):
            return []

        candidates: list[str] = []
        for raw_node in raw_nodes:
            if not isinstance(raw_node, str):
                continue
            node_name = raw_node.strip()
            if not node_name:
                continue
            if node_name.upper() in BUILT_IN_EXCLUDED_NODE_NAMES:
                continue
            if self._is_excluded_by_keyword(node_name):
                continue
            candidates.append(node_name)
        return candidates

    def _is_excluded_by_keyword(self, node_name: str) -> bool:
        lower_name = node_name.lower()
        return any(keyword.lower() in lower_name for keyword in self.config.exclude_keywords)

    def _pick_next_node(self, candidates: list[str], current: str | None) -> str:
        if current not in candidates:
            return candidates[0]
        if len(candidates) == 1:
            return candidates[0]

        current_index = candidates.index(current)
        return candidates[(current_index + 1) % len(candidates)]

    def _select_node(self, group_name: str, node_name: str) -> None:
        self._request_json(
            "PUT",
            f"/proxies/{quote(group_name, safe='')}",
            body={"name": node_name},
        )

    def _wait_until_node_selected(self, group_name: str, node_name: str) -> None:
        deadline = time.time() + SWITCH_CONFIRM_TIMEOUT_SECONDS
        last_now: str | None = None
        while time.time() < deadline:
            group = self._request_json("GET", f"/proxies/{quote(group_name, safe='')}")
            last_now = _string_or_none(group.get("now"))
            if last_now == node_name:
                self.logger(f"Clash confirmed {group_name} is now {node_name}.")
                time.sleep(SWITCH_STABLE_SECONDS)
                return
            time.sleep(SWITCH_CONFIRM_POLL_SECONDS)

        raise RuntimeError(
            f"Clash did not confirm {group_name} switched to {node_name} "
            f"within {SWITCH_CONFIRM_TIMEOUT_SECONDS:.0f}s; last now={last_now or 'unknown'}."
        )

    def _request_json(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = self.config.api_url.rstrip("/") + path
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if self.config.secret:
            headers["Authorization"] = f"Bearer {self.config.secret}"

        request = Request(url, data=data, headers=headers, method=method)
        try:
            with urlopen(request, timeout=8) as response:
                raw_text = response.read().decode("utf-8").strip()
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"Clash API returned HTTP {error.code}: {detail}") from error
        except Exception as error:
            raise RuntimeError(f"Could not reach Clash API at {self.config.api_url}: {error}") from error

        if not raw_text:
            return {}

        try:
            payload = json.loads(raw_text)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"Clash API returned non-JSON text: {raw_text[:200]}") from error

        if not isinstance(payload, dict):
            raise RuntimeError("Clash API returned JSON, but it was not an object.")
        return payload


def _string_or_none(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None
