// 日常入口永远不因宿主PATH/环境变量存在内核而启动真实代理进程。
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const env = { ...process.env, JMS_TEST_NO_CORE: '1' };
for (const key of ['SING_BOX', 'SING_BOX_PATH', 'JMS_CORE', 'JMS_TEST_LINUX_CAPABILITIES']) delete env[key];
const files = readdirSync(new URL('../test/', import.meta.url)).filter(name => name.endsWith('.test.mjs')).sort().map(name => `test/${name}`);
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: new URL('..', import.meta.url), env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
