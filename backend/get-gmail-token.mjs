// One-time script to get Gmail OAuth2 refresh token
// Run: node get-gmail-token.mjs
// Then copy the refresh token into your .env

import http from 'http';
import https from 'https';
import { URL, URLSearchParams } from 'url';

// Fill in your credentials from the downloaded OAuth JSON file:
const CLIENT_ID     = process.env.GMAIL_CLIENT_ID     || 'YOUR_CLIENT_ID_HERE';
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || 'YOUR_CLIENT_SECRET_HERE';
const REDIRECT_URI  = 'http://localhost:8080';
const SCOPE         = 'https://mail.google.com/';

const authUrl =
  'https://accounts.google.com/o/oauth2/auth?' +
  new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         SCOPE,
    access_type:   'offline',
    prompt:        'consent',
  });

console.log('\n=== Gmail OAuth2 Token Generator ===\n');
console.log('1. Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n2. Sign in and click Allow.');
console.log('3. You will be redirected to localhost:8080 — the script will capture the code automatically.\n');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost:8080');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.end(`<h2>Error: ${error}</h2>`);
    console.error('\nAuthorization denied:', error);
    process.exit(1);
  }

  if (!code) {
    res.end('<h2>No code received. Try again.</h2>');
    return;
  }

  res.end('<h2>Authorization successful! Check your terminal for the refresh token.</h2><p>You can close this tab.</p>');

  // Exchange code for tokens
  const body = new URLSearchParams({
    code,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri:  REDIRECT_URI,
    grant_type:    'authorization_code',
  }).toString();

  const postReq = https.request(
    {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    (postRes) => {
      let data = '';
      postRes.on('data', chunk => data += chunk);
      postRes.on('end', () => {
        const json = JSON.parse(data);
        if (json.error) {
          console.error('\nToken exchange failed:', json.error, json.error_description);
          process.exit(1);
        }

        console.log('\n=== SUCCESS — Add these to backend/.env ===\n');
        console.log(`GMAIL_CLIENT_ID=${CLIENT_ID}`);
        console.log(`GMAIL_CLIENT_SECRET=${CLIENT_SECRET}`);
        console.log(`GMAIL_REFRESH_TOKEN=${json.refresh_token}`);
        console.log(`SMTP_FROM=TempWorks <your-gmail@gmail.com>`);
        console.log(`GMAIL_USER=your-gmail@gmail.com`);
        console.log('\n==========================================\n');
        server.close();
      });
    },
  );
  postReq.on('error', err => { console.error('Request error:', err); process.exit(1); });
  postReq.write(body);
  postReq.end();
});

server.listen(8080, () => {
  console.log('Waiting for authorization on http://localhost:8080 ...\n');
});
