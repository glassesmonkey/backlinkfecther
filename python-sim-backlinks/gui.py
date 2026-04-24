from __future__ import annotations

import queue
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from clash_controller import (
    ClashConfig,
    ClashNodeSwitcher,
    DEFAULT_CLASH_API_URL,
    DEFAULT_CLASH_SECRET,
    parse_exclude_keywords,
)
from sim_exporter import (
    DEFAULT_DATA_BROWSER_PROXY,
    TrafficRunConfig,
    default_output_path,
    export_sim_backlinks,
    format_cdp_start_hint,
)


class SimBacklinksApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("Python Similarweb Backlinks Exporter")
        self.root.geometry("820x620")
        self.root.minsize(720, 520)

        self.log_queue: queue.Queue[str] = queue.Queue()
        self.worker: threading.Thread | None = None

        self.cdp_url_var = tk.StringVar(value="http://127.0.0.1:9223")
        self.output_path_var = tk.StringVar(value="")
        self.clash_enabled_var = tk.BooleanVar(value=True)
        self.clash_url_var = tk.StringVar(value=DEFAULT_CLASH_API_URL)
        self.clash_secret_var = tk.StringVar(value=DEFAULT_CLASH_SECRET)
        self.exclude_keywords_var = tk.StringVar(value="")
        self.data_browser_count_var = tk.StringVar(value="2")
        self.data_browser_proxy_var = tk.StringVar(value=DEFAULT_DATA_BROWSER_PROXY)
        self.data_failure_threshold_var = tk.StringVar(value="3")
        self.max_traffic_attempts_var = tk.StringVar(value="8")
        self.cache_path_var = tk.StringVar(value="")
        self.fresh_var = tk.BooleanVar(value=False)
        self.wait_for_delayed_retries_var = tk.BooleanVar(value=False)
        self.status_var = tk.StringVar(value="Ready")

        self.start_button: ttk.Button
        self.test_clash_button: ttk.Button
        self.log_text: tk.Text

        self._build_layout()
        self._poll_logs()

    def _build_layout(self) -> None:
        outer = ttk.Frame(self.root, padding=16)
        outer.pack(fill=tk.BOTH, expand=True)

        form = ttk.LabelFrame(outer, text="Run Settings", padding=12)
        form.pack(fill=tk.X)
        form.columnconfigure(1, weight=1)

        self._add_entry_row(form, 0, "CDP browser URL", self.cdp_url_var)
        self._add_output_row(form, 1)
        self._add_entry_row(form, 2, "Clash controller URL", self.clash_url_var)
        self._add_entry_row(form, 3, "Clash secret", self.clash_secret_var, show="*")
        self._add_entry_row(form, 4, "Exclude node keywords", self.exclude_keywords_var)
        self._add_entry_row(form, 5, "Data browser count", self.data_browser_count_var)
        self._add_entry_row(form, 6, "Data browser proxy", self.data_browser_proxy_var)
        self._add_entry_row(form, 7, "Failure threshold", self.data_failure_threshold_var)
        self._add_entry_row(form, 8, "Max traffic attempts", self.max_traffic_attempts_var)
        self._add_cache_row(form, 9)

        clash_check = ttk.Checkbutton(
            form,
            text="Auto switch Clash node when Similarweb fails",
            variable=self.clash_enabled_var,
        )
        clash_check.grid(row=10, column=1, sticky="w", pady=(8, 0))

        fresh_check = ttk.Checkbutton(
            form,
            text="Ignore existing cache and start fresh",
            variable=self.fresh_var,
        )
        fresh_check.grid(row=11, column=1, sticky="w", pady=(8, 0))

        wait_check = ttk.Checkbutton(
            form,
            text="Keep running while waiting for delayed retries",
            variable=self.wait_for_delayed_retries_var,
        )
        wait_check.grid(row=12, column=1, sticky="w", pady=(8, 0))

        actions = ttk.Frame(outer)
        actions.pack(fill=tk.X, pady=(12, 8))

        self.test_clash_button = ttk.Button(
            actions,
            text="Test Clash",
            command=self._start_test_clash,
        )
        self.test_clash_button.pack(side=tk.LEFT)

        self.start_button = ttk.Button(
            actions,
            text="Start Export",
            command=self._start_export,
        )
        self.start_button.pack(side=tk.LEFT, padx=(8, 0))

        status = ttk.Label(actions, textvariable=self.status_var)
        status.pack(side=tk.RIGHT)

        log_frame = ttk.LabelFrame(outer, text="Logs", padding=8)
        log_frame.pack(fill=tk.BOTH, expand=True)

        self.log_text = tk.Text(log_frame, height=18, wrap="word")
        self.log_text.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        scrollbar = ttk.Scrollbar(log_frame, command=self.log_text.yview)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.log_text.configure(yscrollcommand=scrollbar.set)

    def _add_entry_row(
        self,
        parent: ttk.Frame,
        row: int,
        label: str,
        variable: tk.StringVar,
        *,
        show: str | None = None,
    ) -> None:
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", pady=6, padx=(0, 12))
        entry = ttk.Entry(parent, textvariable=variable, show=show)
        entry.grid(row=row, column=1, sticky="ew", pady=6)

    def _add_output_row(self, parent: ttk.Frame, row: int) -> None:
        ttk.Label(parent, text="Output CSV").grid(row=row, column=0, sticky="w", pady=6, padx=(0, 12))
        entry = ttk.Entry(parent, textvariable=self.output_path_var)
        entry.grid(row=row, column=1, sticky="ew", pady=6)
        browse_button = ttk.Button(parent, text="Browse", command=self._choose_output_file)
        browse_button.grid(row=row, column=2, sticky="e", padx=(8, 0), pady=6)

    def _add_cache_row(self, parent: ttk.Frame, row: int) -> None:
        ttk.Label(parent, text="Cache JSON").grid(row=row, column=0, sticky="w", pady=6, padx=(0, 12))
        entry = ttk.Entry(parent, textvariable=self.cache_path_var)
        entry.grid(row=row, column=1, sticky="ew", pady=6)
        browse_button = ttk.Button(parent, text="Browse", command=self._choose_cache_file)
        browse_button.grid(row=row, column=2, sticky="e", padx=(8, 0), pady=6)

    def _choose_output_file(self) -> None:
        path = filedialog.asksaveasfilename(
            title="Choose output CSV",
            defaultextension=".csv",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")],
        )
        if path:
            self.output_path_var.set(path)

    def _choose_cache_file(self) -> None:
        path = filedialog.asksaveasfilename(
            title="Choose cache JSON",
            defaultextension=".json",
            filetypes=[("JSON files", "*.json"), ("All files", "*.*")],
        )
        if path:
            self.cache_path_var.set(path)

    def _start_test_clash(self) -> None:
        if self.worker and self.worker.is_alive():
            messagebox.showinfo("Busy", "A task is already running.")
            return

        self._set_busy(True, "Testing Clash...")
        self.worker = threading.Thread(target=self._test_clash_worker, daemon=True)
        self.worker.start()

    def _test_clash_worker(self) -> None:
        try:
            switcher = ClashNodeSwitcher(self._build_clash_config(enabled=True), logger=self._log)
            self._log(switcher.test_connection())
            self._set_ready_from_worker("Clash test finished")
        except Exception as error:
            self._log(f"ERROR: {error}")
            self._set_ready_from_worker("Clash test failed")

    def _start_export(self) -> None:
        if self.worker and self.worker.is_alive():
            messagebox.showinfo("Busy", "A task is already running.")
            return

        self.log_text.delete("1.0", tk.END)
        self._set_busy(True, "Exporting...")
        self.worker = threading.Thread(target=self._export_worker, daemon=True)
        self.worker.start()

    def _export_worker(self) -> None:
        output_text = self.output_path_var.get().strip()
        output_path = Path(output_text).expanduser() if output_text else default_output_path()
        cdp_url = self.cdp_url_var.get().strip() or None
        cache_text = self.cache_path_var.get().strip()

        try:
            result = export_sim_backlinks(
                cdp_url=cdp_url,
                output_path=output_path,
                clash_config=self._build_clash_config(enabled=self.clash_enabled_var.get()),
                traffic_config=TrafficRunConfig(
                    data_browser_count=self._read_positive_int(self.data_browser_count_var, "Data browser count"),
                    data_failure_threshold=self._read_positive_int(self.data_failure_threshold_var, "Failure threshold"),
                    max_traffic_attempts=self._read_positive_int(self.max_traffic_attempts_var, "Max traffic attempts"),
                    data_browser_proxy=self.data_browser_proxy_var.get().strip(),
                    wait_for_delayed_retries=self.wait_for_delayed_retries_var.get(),
                    cache_path=Path(cache_text).expanduser() if cache_text else None,
                    fresh=self.fresh_var.get(),
                ),
                logger=self._log,
            )
            self._log("")
            self._log(f"Done. Exported {result.exported_count} rows to {result.output_path}")
            if result.deferred_failed_count:
                self._log(
                    f"Deferred failed {result.deferred_failed_count} hostnames after all Similarweb retries."
                )
            self._set_ready_from_worker("Done")
        except Exception as error:
            self._log(f"ERROR: {error}")
            if "CDP" in str(error) or "Chrome" in str(error):
                self._log("")
                self._log(format_cdp_start_hint())
            self._set_ready_from_worker("Failed")

    def _build_clash_config(self, *, enabled: bool) -> ClashConfig:
        return ClashConfig(
            enabled=enabled,
            api_url=self.clash_url_var.get().strip() or DEFAULT_CLASH_API_URL,
            secret=self.clash_secret_var.get().strip(),
            exclude_keywords=parse_exclude_keywords(self.exclude_keywords_var.get()),
        )

    def _read_positive_int(self, variable: tk.StringVar, label: str) -> int:
        try:
            value = int(variable.get().strip())
        except ValueError as error:
            raise ValueError(f"{label} must be a positive integer.") from error
        if value < 1:
            raise ValueError(f"{label} must be a positive integer.")
        return value

    def _set_busy(self, is_busy: bool, status: str) -> None:
        state = tk.DISABLED if is_busy else tk.NORMAL
        self.start_button.configure(state=state)
        self.test_clash_button.configure(state=state)
        self.status_var.set(status)

    def _set_ready_from_worker(self, status: str) -> None:
        self.root.after(0, lambda: self._set_busy(False, status))

    def _log(self, message: str) -> None:
        self.log_queue.put(message)

    def _poll_logs(self) -> None:
        while True:
            try:
                message = self.log_queue.get_nowait()
            except queue.Empty:
                break
            self.log_text.insert(tk.END, message + "\n")
            self.log_text.see(tk.END)
        self.root.after(100, self._poll_logs)


def run_gui() -> None:
    root = tk.Tk()
    SimBacklinksApp(root)
    root.mainloop()
