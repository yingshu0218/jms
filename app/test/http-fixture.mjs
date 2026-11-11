// 测试专用虚构凭据，绝不作为实际引擎默认值。
export const TEST_SERVER_AUTH = { authToken: 'fixture-only-api-token-not-for-runtime-0001', instanceId: 'fixture-instance' };
export const authenticatedFetch = (url, options = {}) => fetch(url, {
  ...options, headers: { Authorization: `Bearer ${TEST_SERVER_AUTH.authToken}`, ...options.headers },
});
