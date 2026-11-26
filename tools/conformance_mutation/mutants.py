"""Documented-contract mutants for the conformance suites (see run.py).

Each entry is a list of
(repo:path, old, new) exact single-occurrence replacements; repo is "kernel" (vendor/LLMKernel)
or "notebook" (this repository). CONTRACTS says which documented behaviour each one breaks.
"""

CONTRACTS = {'facade-no-operator-bridge': 'RFC-006 §6 Family D: Kernel.start builds the OperatorBridgeServer, so '
                              'operator.action (incl. the in-session grant) reaches the kernel',
 'pty-no-signal-handlers': 'RFC-008 §3/§4: SIGTERM is a clean shutdown with a final snapshot; SIGINT '
                           'interrupts',
 'facade-no-drift-detector': 'RFC-006 §8 / RFC-008 §4: a hydrate runs DriftDetector.compare in every start '
                             'path',
 'pin-in-agent-env': "PLAN-S5.0.1 §3.1: the operator pin never reaches an agent's environment",
 'facade-no-wire-sanitizer': 'PLAN-S5.0.1 §3.3 Layer 2: in hash mode the wire never carries a hashed-magic '
                             'line',
 'facade-no-contamination': "PLAN-S5.0.1 Layer 1: an agent's plain magic flags its bound cell",
 'hydrate-not-exclusive': 'RFC-006 §9: at most one hydrate per session',
 'heartbeat-30s': 'RFC-006 §7 Family E: heartbeat.kernel every 5 s',
 'pty-no-shutdown-event': 'RFC-006 §7.1: kernel.shutdown_request ends a pty-mode kernel',
 'serve-minor-skew-silent': 'wire-handshake atom: a client minor skew is accepted with a minor_version_skew '
                            'warning',
 'serve-major-mismatch-accepted': 'wire-handshake atom: a wire major mismatch gets version_mismatch_major '
                                  'and a close',
 'serve-wrong-token-accepted': 'wire-handshake atom / RFC-006 §T3: a wrong bearer token gets auth_failed',
 'hydrate-trust-not-quarantined': 'PLAN-S5.0.1 §3.5: file-sourced magic-emit grants only count after an '
                                  'in-session grant',
 'health-no-session': "PLAN-kernel-facade commit 8: /health reports the attached kernel's session",
 'pty-connect-fail-exit-1': '_wiring-audit §3a / BSP-001: pty-mode exits 3 when it cannot connect its socket',
 'ready-frame-no-session-id': 'RFC-008 §4: the kernel.ready record carries llmnb.kernel.session_id',
 'validate-drops-advisories': 'llmnb validate (PLAN-S5.0.3 §6.1): K33/K35 advisories are printed as warnings',
 'emit-without-grant': 'certified-magic-emitter / PLAN-S5.0.4 §3.1: emit_magic_cell refuses an agent without '
                       'a covering grant (K3K)',
 'serve-second-client-accepted': 'RFC-006 §T4: a second simultaneous client gets kernel_busy',
 'sigint-shuts-down': 'RFC-008 §4 step 5: SIGINT interrupts and does not shut the kernel down',
 'sigterm-ignored': 'RFC-008 §3: SIGTERM is a clean shutdown',
 'patch-mode-accepted': 'RFC-006 §8: an inbound notebook.metadata mode "patch" is rejected',
 'pty-proxy-rejected-exit-1': 'BSP-001: pty-mode exits 11 when the proxy configuration is rejected'}

MUTANTS = {'facade-no-operator-bridge': [('kernel:llm_kernel/kernel_facade.py',
                                '                bridge = OperatorBridgeServer(\n'
                                '                    agent_id=agent_id, zone_id=zone_id, trace_id=trace_id,\n'
                                '                    run_tracker=run_tracker, dispatcher=dispatcher,\n'
                                '                )\n'
                                '                bridge.kernel = kernel\n'
                                '                bridge.agent_supervisor = supervisor\n'
                                '                bridge.metadata_writer = metadata_writer\n',
                                '                bridge = None\n')],
 'pty-no-signal-handlers': [('kernel:llm_kernel/transports/pty_mode.py',
                             '        _install_signal_handlers(self.shutdown_event, self.interrupt_event)\n',
                             '')],
 'facade-no-drift-detector': [('kernel:llm_kernel/kernel_facade.py',
                               '                dispatcher.set_drift_detector(DriftDetector())\n',
                               '')],
 'pin-in-agent-env': [('kernel:llm_kernel/supervision/_provisioning.py',
                       '    env.pop(OPERATOR_PIN_ENV_VAR, None)\n',
                       '')],
 'facade-no-wire-sanitizer': [('kernel:llm_kernel/kernel_facade.py',
                               '                    socket_writer=_socket_writer_of(self._kernel_shell),\n',
                               '                    socket_writer=None,\n')],
 'facade-no-contamination': [('kernel:llm_kernel/kernel_facade.py',
                              '                wire_magic_defense(\n'
                              '                    supervisor=supervisor, metadata_writer=metadata_writer,\n'
                              '                    socket_writer=_socket_writer_of(self._kernel_shell),\n'
                              '                )\n',
                              '')],
 'hydrate-not-exclusive': [('kernel:llm_kernel/capture/custom_messages.py',
                            '            already = self._hydrate_processed\n',
                            '            already = False\n')],
 'heartbeat-30s': [('kernel:llm_kernel/capture/custom_messages.py',
                    'DEFAULT_HEARTBEAT_INTERVAL_SEC: float = 5.0\n',
                    'DEFAULT_HEARTBEAT_INTERVAL_SEC: float = 30.0\n')],
 'pty-no-shutdown-event': [('kernel:llm_kernel/transports/pty_mode.py',
                            '        if hasattr(dispatcher, "set_shutdown_event"):\n'
                            '            dispatcher.set_shutdown_event(self.shutdown_event)\n',
                            '')],
 'serve-minor-skew-silent': [('kernel:llm_kernel/transports/serve_mode.py',
                              '        warnings.append("minor_version_skew")\n',
                              '        pass\n')],
 'serve-major-mismatch-accepted': [('kernel:llm_kernel/transports/serve_mode.py',
                                    '        return ("version_mismatch_major", [])\n',
                                    '        pass\n')],
 'serve-wrong-token-accepted': [('kernel:llm_kernel/transports/serve_mode.py',
                                 '        presented.encode("utf-8"), expected_token.encode("utf-8"),\n'
                                 '    ):\n'
                                 '        return ("auth_failed", warnings)\n',
                                 '        presented.encode("utf-8"), expected_token.encode("utf-8"),\n'
                                 '    ):\n'
                                 '        pass\n')],
 'hydrate-trust-not-quarantined': [('kernel:llm_kernel/capture/metadata_writer/_writer.py',
                                    '                self._quarantine_persisted_trust()\n',
                                    '                pass\n')],
 'health-no-session': [('kernel:llm_kernel/app.py',
                        '            getattr(request.app.state, "session_id", None) if attached else None\n',
                        '            None\n')],
 'pty-connect-fail-exit-1': [('kernel:llm_kernel/transports/pty_mode.py',
                              '                "pty_mode_exit_socket_connect_failed", error=str(exc), rc=3,\n'
                              '            )\n'
                              '            return 3\n',
                              '                "pty_mode_exit_socket_connect_failed", error=str(exc), rc=3,\n'
                              '            )\n'
                              '            return 1\n')],
 'ready-frame-no-session-id': [('kernel:llm_kernel/transports/pty_mode.py',
                                '        "llmnb.kernel.session_id": session_id,\n',
                                '')],
 'validate-drops-advisories': [('notebook:llm_client/cli/validate.py',
                                '    if advisories:\n        for cid, code, reason in advisories:\n',
                                '    if False:\n        for cid, code, reason in advisories:\n')],
 'emit-without-grant': [('kernel:llm_kernel/magics/magic_emit_tool.py',
                         '    if not has_grant_fn(agent_id=agent_id, zone_id=zone_id, magic_name=name):\n',
                         '    if False:\n')],
 'serve-second-client-accepted': [('kernel:llm_kernel/transports/serve_mode.py',
                                   '                if active_thread is not None and '
                                   'active_thread.is_alive():\n',
                                   '                if False:\n')],
 'sigint-shuts-down': [('kernel:llm_kernel/transports/pty_mode.py',
                        '    def _on_sigint(_signum: int, _frame: Any) -> None:\n'
                        '        interrupt_event.set()\n',
                        '    def _on_sigint(_signum: int, _frame: Any) -> None:\n'
                        '        shutdown_event.set()\n')],
 'sigterm-ignored': [('kernel:llm_kernel/transports/pty_mode.py',
                      '    def _on_sigterm(_signum: int, _frame: Any) -> None:\n'
                      '        shutdown_event.set()\n',
                      '    def _on_sigterm(_signum: int, _frame: Any) -> None:\n        pass\n')],
 'patch-mode-accepted': [('kernel:llm_kernel/capture/custom_messages.py',
                          '        if mode == "patch":\n',
                          '        if False:\n')],
 'pty-proxy-rejected-exit-1': [('kernel:llm_kernel/transports/pty_mode.py',
                                '        if proxy_server is _PROXY_CONFIG_REJECTED:\n'
                                '            self._restore_terminal()\n'
                                '            return 11\n',
                                '        if proxy_server is _PROXY_CONFIG_REJECTED:\n'
                                '            self._restore_terminal()\n'
                                '            return 1\n')]}
