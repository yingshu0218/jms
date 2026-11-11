// Opt-in only: never enumerated by test-safe.mjs. No download or PATH fallback.
import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
const required = process.argv.includes('--require');
const binary = process.env.SING_BOX;
if (process.env.JMS_ALLOW_ISOLATED_CORE_TESTS !== '1' || !binary) {
  console.log('SKIP isolated core integration: explicit SING_BOX and JMS_ALLOW_ISOLATED_CORE_TESTS=1 required');
  process.exitCode = required ? 1 : 0;
} else if (!isAbsolute(binary)) {
  console.error('FAIL SING_BOX must be an explicit absolute path');
  process.exitCode = 1;
} else {
  const version = spawnSync(binary, ['version'], { encoding: 'utf8', timeout: 10000 });
  if (version.status !== 0 || !/^sing-box version 1\.14\.3\s*$/m.test(version.stdout || '')) {
    console.error('FAIL isolated integration requires exact sing-box version 1.14.3');
    process.exitCode = 1;
  } else {
    const env = { ...process.env };
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];
    env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost';
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', 'test/local-core-integration.mjs'], {
      cwd: new URL('..', import.meta.url), env, stdio: 'inherit',
    });
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;
  }
}
