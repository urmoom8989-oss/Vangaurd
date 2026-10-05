// Vangaurd: sends sign-up, sign-in and password-reset codes from this Gmail account.
//
// Setup (once):
//   1. Go to https://script.google.com while signed in to the Gmail account that should send the codes,
//      choose New project, delete what is there and paste this whole file. Name the project "Vangaurd mail".
//   2. Change KEY below to a long random value (or keep the one you were given) and save.
//   3. Deploy > New deployment > type "Web app". Execute as: Me. Who has access: Anyone. Deploy.
//      Google asks you to authorize: choose your account, then Advanced > Go to Vangaurd mail > Allow
//      (it is your own script, so Google shows the "unverified" warning).
//   4. Copy the Web app URL (it ends in /exec). On Railway, set these variables on the server:
//        GMAIL_SCRIPT_URL = that URL
//        GMAIL_SCRIPT_KEY = the KEY below
//   The server checks the script when it starts; /health then shows "emailReady": true.
//
// Gmail lets a script send about 100 emails a day on a normal Google account.
// The server only sends the address, the code and what it is for; the email itself is written here, so the
// URL cannot be used to send anything but Vangaurd codes.

const KEY = '__VANGAURD_KEY__';

const PURPOSE = {
  register: ['finish creating your Vangaurd account', 'Verify your email'],
  login: ['sign in to Vangaurd', 'Sign-in code'],
  add_email: ['add this email to your Vangaurd account', 'Confirm your email'],
  reset: ['reset your Vangaurd password', 'Password reset'],
};
const EMAIL = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$/;

function reply_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function keyError_(k) {
  if (KEY === '__VANGAURD_' + 'KEY__' || KEY.length < 16) return 'set KEY in the script to a long random value first';
  if (k !== KEY) return 'wrong key: GMAIL_SCRIPT_KEY on Railway must match KEY in the script';
  return '';
}

// The server's start-up check (sends nothing).
function doGet(e) {
  const bad = keyError_(e && e.parameter ? e.parameter.key : '');
  if (bad) return reply_({ ok: false, error: bad });
  return reply_({ ok: true, quota: MailApp.getRemainingDailyQuota() });
}

function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (x) { return reply_({ ok: false, error: 'bad request' }); }
  const bad = keyError_(d && d.key);
  if (bad) return reply_({ ok: false, error: bad });
  const to = String(d.to || '').trim(), code = String(d.code || '');
  const name = String(d.username || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16);
  if (!EMAIL.test(to) || !/^\d{6}$/.test(code)) return reply_({ ok: false, error: 'bad request' });
  if (MailApp.getRemainingDailyQuota() < 1) return reply_({ ok: false, error: "Gmail's daily sending limit is used up" });
  const p = PURPOSE[d.purpose] || PURPOSE.login, who = name ? ' (' + name + ')' : '';
  const text = 'Your Vangaurd code is ' + code + '\n\nUse it to ' + p[0] + who + '. It expires in 10 minutes.\n\n' +
    "If you didn't ask for this code, you can ignore this email. Nobody can get into the account without it.\n\nVangaurd";
  const html = '<div style="margin:0;padding:24px;background:#0b0e10;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#e9ece6">' +
    '<div style="max-width:440px;margin:0 auto;background:#12171b;border:1px solid #262d33;border-top:3px solid #f2c14e;padding:28px">' +
    '<div style="font-weight:800;letter-spacing:.3em;font-size:18px">VANGAURD</div>' +
    '<div style="color:#f2c14e;font-size:11px;font-weight:700;letter-spacing:.24em;text-transform:uppercase;margin-top:4px">' + p[1] + '</div>' +
    '<p style="margin:22px 0 10px;color:#b9bfb8;font-size:14px;line-height:1.5">Use this code to ' + p[0] + who + ':</p>' +
    '<div style="font-size:34px;font-weight:800;letter-spacing:.32em;color:#ffffff;background:#0b0e10;border:1px solid #2c343a;padding:14px 0;text-align:center">' + code + '</div>' +
    '<p style="margin:16px 0 0;color:#8e968f;font-size:12px;line-height:1.5">It expires in 10 minutes. If you didn\'t ask for this code, ignore this email. Nobody can get into the account without it.</p>' +
    '</div></div>';
  MailApp.sendEmail({ to: to, subject: 'Your Vangaurd code: ' + code, name: 'Vangaurd', body: text, htmlBody: html });
  return reply_({ ok: true, quota: MailApp.getRemainingDailyQuota() });
}
