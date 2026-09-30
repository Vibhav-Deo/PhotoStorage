const COGNITO_DOMAIN = 'photo-archive-860100076027.auth.ap-southeast-2.amazoncognito.com';
const CLIENT_ID = '5p87d5r4ojifi4p511nqehk4bg';
const REDIRECT_URI = 'http://localhost:3000/';
const SESSION_KEY = 'photo-archive.auth-session';
const VERIFIER_KEY = 'photo-archive.pkce-verifier';
const STATE_KEY = 'photo-archive.oauth-state';

export interface WebAuthSession {
  readonly idToken: string;
  readonly accessToken: string;
  readonly expiresAt: number;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

async function createPkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function randomValue(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function startSignIn(): Promise<void> {
  const verifier = randomValue();
  const state = randomValue();
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const challenge = await createPkceChallenge(verifier);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  window.location.assign(`https://${COGNITO_DOMAIN}/oauth2/authorize?${params}`);
}

export async function completeSignIn(): Promise<WebAuthSession | null> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return getStoredSession();

  const expectedState = sessionStorage.getItem(STATE_KEY);
  if (!expectedState || expectedState !== params.get('state')) {
    throw new Error('Invalid sign-in state');
  }

  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error('Missing sign-in verifier');

  const response = await fetch(`https://${COGNITO_DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) throw new Error(`Sign-in failed (${String(response.status)})`);
  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data['id_token'] !== 'string' || typeof data['access_token'] !== 'string') {
    throw new Error('Sign-in response did not contain the required tokens');
  }

  const session: WebAuthSession = {
    idToken: data['id_token'],
    accessToken: data['access_token'],
    expiresAt:
      Date.now() + (typeof data['expires_in'] === 'number' ? data['expires_in'] : 3600) * 1000,
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  window.history.replaceState({}, document.title, REDIRECT_URI);
  return session;
}

export function getStoredSession(): WebAuthSession | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as WebAuthSession;
    if (session.expiresAt <= Date.now()) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return session;
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export async function signOut(session: WebAuthSession): Promise<void> {
  localStorage.removeItem(SESSION_KEY);
  await fetch(`https://${COGNITO_DOMAIN}/oauth2/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: session.accessToken, client_id: CLIENT_ID }),
  }).catch(() => undefined);
}
