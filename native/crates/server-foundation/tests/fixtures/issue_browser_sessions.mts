// Test-only compatibility fixture: use the actual existing issuers, never an
// independent reimplementation of their cookie signature algorithm.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const root = process.env.RUDDER_BROWSER_AUTH_ISSUER_ROOT!;
const databaseUrl = process.env.RUDDER_NATIVE_AUTH_TEST_DATABASE_URL!;
if (!root || !new URL(databaseUrl).pathname.includes('test')) throw new Error('disposable test database required');
const require = createRequire(path.join(root, 'server/package.json'));
const { createDb, applyPendingMigrations } = await import(pathToFileURL(require.resolve('@rudderhq/db')).href);
const { createBetterAuthInstance, resolveBetterAuthSessionFromHeaders } = await import(pathToFileURL(path.join(root, 'server/src/auth/better-auth.ts')).href);
const { localAccountAuthService, createLocalAccountSessionResolver } = await import(pathToFileURL(path.join(root, 'server/src/services/local-account-auth.ts')).href);
const secret = 'native-browser-auth-test-secret-32-bytes-minimum';
process.env.BETTER_AUTH_SECRET = secret;
process.env.RUDDER_PUBLIC_URL = 'http://localhost:3100';
await applyPendingMigrations(databaseUrl);
const db = createDb(databaseUrl);
try {
  const fixtures: {issuer: string; userId: string; cookie: string; secure: boolean; referenceRefresh: boolean}[] = [];
  for (const secure of [false, true]) for (const rememberMe of [true, false]) {
    process.env.RUDDER_PUBLIC_URL = secure ? 'https://auth.invalid.test' : 'http://localhost:3100';
    const auth = createBetterAuthInstance(db, {
      authBaseUrlMode: 'explicit', authPublicBaseUrl: process.env.RUDDER_PUBLIC_URL,
      deploymentMode: 'authenticated', allowedHostnames: [], authDisableSignUp: false,
    });
    const response = await auth.api.signUpEmail({
      asResponse: true,
      body: {name: 'Native Cookie Test', email: `native-${randomUUID()}@invalid.test`, password: `test-only-${randomUUID()}`, rememberMe},
    });
    if (response.status !== 200) throw new Error(`fixture signup failed: ${response.status}`);
    const body = await response.json();
    const name = secure ? '__Secure-better-auth.session_token=' : 'better-auth.session_token=';
    const parts = response.headers.getSetCookie().filter((v: string) => v.startsWith(name) || v.startsWith(secure ? '__Secure-better-auth.dont_remember=' : 'better-auth.dont_remember=')).map((v: string) => v.split(';')[0]);
    const cookie = parts.join('; ');
    if (!cookie) throw new Error('real Better Auth session cookie missing');
    await db.$client`UPDATE session SET expires_at=now()+interval '2 days' WHERE user_id=${body.user.id}`;
    if (!await resolveBetterAuthSessionFromHeaders(auth, new Headers({cookie}))) throw new Error('reference issuer rejected its own cookie');
    const [renewal] = await db.$client`SELECT expires_at>now()+interval '6 days' AS refreshed FROM session WHERE user_id=${body.user.id}`;
    if (renewal.refreshed !== rememberMe) throw new Error('Better Auth renewal policy changed');
    await db.$client`UPDATE session SET expires_at=now()+interval '2 days' WHERE user_id=${body.user.id}`;
    fixtures.push({issuer: 'better-auth', userId: body.user.id, cookie, secure, referenceRefresh: renewal.refreshed});
  }
  for (const secure of [false, true]) {
    const claims = {issuer: 'https://accounts.rudderhq.dev', subject: randomUUID(), audience: 'rudder-installation:test', installationId: 'native-browser-auth-test', jti: randomUUID(), expiresAt: new Date(Date.now()+60_000), email: `local-${randomUUID()}@invalid.test`, emailVerified: true, name: 'Native Local Cookie Test'};
    const service = localAccountAuthService(db, {expectedIssuer: claims.issuer, audience: claims.audience, installationId: claims.installationId, secureCookie: secure, sessionSecret: secret, verifier: {verify: async () => claims}});
    const issued = await service.redeem('synthetic-exchange-code');
    const cookie = issued.session.setCookie.split(';')[0];
    await db.$client`UPDATE session SET expires_at=now()+interval '2 days' WHERE user_id=${issued.userId}`;
    if (!await createLocalAccountSessionResolver(db,{sessionSecret:secret, secureCookie:secure})({cookie})) throw new Error('reference local resolver rejected its own cookie');
    const [renewal] = await db.$client`SELECT expires_at>now()+interval '6 days' AS refreshed FROM session WHERE user_id=${issued.userId}`;
    if (renewal.refreshed) throw new Error('Local account renewal policy changed');
    fixtures.push({issuer: 'local-account', userId: issued.userId, cookie, secure, referenceRefresh:false});
  }
  await writeFile(process.env.RUDDER_BROWSER_AUTH_FIXTURE!, JSON.stringify({secret, fixtures}, null, 2)+'\n', {mode: 0o600});
  console.log('Issued six synthetic browser sessions using existing auth runtimes.');
} finally { await db.$client.end(); }
