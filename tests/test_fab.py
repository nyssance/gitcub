"""开发任务回归：不启动应用、不下载依赖、不删除真实编译产物。"""
import builtins
import dis
import types
import unittest
from unittest.mock import Mock, patch

from invoke import Context, Result

import fabfile as fab


class TaskTests(unittest.TestCase):
    def test_clean_all_choices_execute_requested_commands(self):
        for mode, expected in {
            'sweep': ['which cargo-sweep', 'cargo install cargo-sweep',
                      'cargo sweep --installed', 'cargo sweep --time 30'],
            'full': ['cargo clean'],
            'dirs': [],
        }.items():
            with self.subTest(mode=mode), patch.object(fab.inquirer, 'select') as select:
                select.return_value.execute.return_value = mode
                context = Context()
                with patch.object(context, 'run', return_value=Result(exited=1)) as run:
                    fab.clean(context)
                self.assertEqual([call.args[0] for call in run.call_args_list],
                                 expected + ['find . -type d -empty -print -delete'])

    def test_format_includes_rust_before_frontend(self):
        context = Context()
        with patch.object(fab, '_workspace_packages', return_value=['-p', 'gitcub']), \
                patch.object(context, 'run') as run:
            fab.format_code(context)
        self.assertEqual(run.call_args_list[0].args[0], 'cargo fmt -p gitcub')
        self.assertEqual(run.call_args_list[1].args[0], 'bun fmt')
        self.assertEqual(run.call_count, 2)

    def test_check_continues_after_failure_and_returns_failure(self):
        with patch.object(fab, '_workspace_packages', return_value=[]), \
                patch.object(fab.subprocess, 'run') as run, patch.object(fab.rich, 'print'):
            run.side_effect = lambda command, **kwargs: Mock(returncode=int(command == ["bun", "check", "--no-script", "-p", "tsconfig.json"]))
            with self.assertRaises(SystemExit) as failure:
                fab.check(Context())
        self.assertEqual(failure.exception.code, 1)
        self.assertEqual(run.call_count, 10)
        self.assertEqual(run.call_args_list[0].args[0],
                         ['bun', 'check', '--no-script', '-p', 'tsconfig.json'])
        self.assertEqual(run.call_args_list[1].args[0],
                         ['bun', 'check', '--no-script', '-p', 'tsconfig.tools.json'])
        self.assertEqual(run.call_args_list[-1].args[0],
                         ['cargo', 'test', '--locked', '--workspace'])

    def test_dev_replaces_process_and_enables_hasgard(self):
        with patch.object(fab, '_bundled_git_ready', return_value=True), \
                patch.object(fab.os, 'chdir'), patch.object(fab.os, 'execvp') as execute:
            fab.dev(Context())
        execute.assert_called_once_with('bunx', [
            'bunx', '--bun', 'tauri', 'dev', '--config',
            'src-tauri/tauri.dev-instance.conf.json', '--features', 'hasgard-testing'])

    def test_install_keeps_bundled_git_and_installs_missing_hasgard(self):
        context = Context()
        with patch.object(fab, '_sibling_packages', return_value=[]), \
                patch.object(context, 'run', return_value=Result(exited=1)) as run, \
                patch.object(fab, 'git_download') as download:
            fab.install(context)
        self.assertEqual([call.args[0] for call in run.call_args_list],
                         ['bun install', 'command -v tauri-hasgard',
                          'cargo install tauri-hasgard-cli'])
        download.assert_called_once_with(context)

    def test_upgrade_orders_dependencies(self):
        context = Context()
        with patch.object(fab, '_sibling_packages', return_value=[]), \
                patch.object(context, 'run', return_value=Result(exited=0)) as run, \
                patch.object(fab.shutil, 'rmtree') as remove:
            fab.upgrade(context)
        self.assertEqual([call.args[0] for call in run.call_args_list],
                         ['git pull --ff-only', 'bun outdated', 'bun update', 'cargo update',
                          'command -v cargo-upgrade', 'cargo upgrade --dry-run --incompatible allow --pinned allow'])
        remove.assert_not_called()

    def test_helpers_have_no_missing_global_imports(self):
        # 包括嵌套 worker，防止 cell_len 等依赖只在交互任务运行时才报错。
        available = set(vars(fab)) | set(vars(builtins))

        def check(code):
            for instruction in dis.get_instructions(code):
                if instruction.opname == 'LOAD_GLOBAL':
                    self.assertIn(instruction.argval, available, code.co_name)
            for const in code.co_consts:
                if isinstance(const, types.CodeType):
                    check(const)

        for value in vars(fab).values():
            function = getattr(value, 'body', value)
            if isinstance(function, types.FunctionType) and function.__module__ == 'fabfile':
                check(function.__code__)


if __name__ == '__main__':
    unittest.main()
