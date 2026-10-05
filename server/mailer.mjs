// Sends Vangaurd's verification-code emails. Configure ONE of these on the server (Railway variables):
//
//   Gmail through a Google Apps Script web app (free, works on every Railway plan; see gmail-script.gs):
//     GMAIL_SCRIPT_URL=<the web app URL ending in /exec>  GMAIL_SCRIPT_KEY=<the KEY written in the script>
//   Gmail over SMTP (Railway only allows outbound SMTP on the Pro plan and above):
//     SMTP_HOST=smtp.gmail.com  SMTP_PORT=465  SMTP_USER=you@gmail.com  SMTP_PASS=<16-letter app password>
//   Brevo (free, works on every Railway plan; sends over HTTPS):
//     BREVO_API_KEY=<key>  MAIL_FROM=<a sender address verified in Brevo>
//
//   Optional: MAIL_FROM (defaults to SMTP_USER), MAIL_FROM_NAME (defaults to "Vangaurd").
//   Tests: MAIL_CAPTURE_FILE=<path> writes each email as a JSON line instead of sending it.
//
// check() tests the configured sender without sending anything (the server runs it at start).
import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';

export function createMailer(env = process.env) {
  const from = String(env.MAIL_FROM || env.SMTP_USER || '').trim();
  const fromName = String(env.MAIL_FROM_NAME || 'Vangaurd').replace(/["\r\n]/g, '').slice(0, 60);
  let kind = null;
  if (env.MAIL_CAPTURE_FILE) kind = 'capture';
  else if (env.GMAIL_SCRIPT_URL) kind = 'gmail';
  else if (env.BREVO_API_KEY && from) kind = 'brevo';
  else if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && from) kind = 'smtp';

  const scriptUrl = String(env.GMAIL_SCRIPT_URL || '').trim(), scriptKey = String(env.GMAIL_SCRIPT_KEY || '').trim();
  async function send({ to, subject, text, html, code, purpose, username }) {
    if (!kind) throw new Error('email is not configured');
    if (kind === 'gmail') {
      // The script writes the email itself from these fields, so a leaked URL can only send Vangaurd codes.
      const r = await fetch(scriptUrl, {
        method: 'POST', redirect: 'follow', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: scriptKey, to, code, purpose, username }), signal: AbortSignal.timeout(20000),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(`Gmail script ${r.status}: ${j?.error || 'no answer (is it deployed as a web app with access "Anyone"?)'}`);
      return { ok: true, quota: j.quota };
    }
    if (kind === 'capture') {
      fs.appendFileSync(env.MAIL_CAPTURE_FILE, JSON.stringify({ at: Date.now(), from, to, subject, text }) + '\n');
      return { ok: true };
    }
    if (kind === 'brevo') {
      const r = await fetch(env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: { name: fromName, email: from }, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`Brevo ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
      return { ok: true };
    }
    const port = Number(env.SMTP_PORT) || 465;
    return smtpSend({
      host: env.SMTP_HOST, port, secure: env.SMTP_SECURE ? env.SMTP_SECURE !== 'false' : port === 465,
      user: env.SMTP_USER, pass: env.SMTP_PASS, from, fromName, to, subject, text, html,
    });
  }
  // Is the sender set up right? Sends nothing.
  async function check() {
    if (!kind) return { ok: false, detail: 'no email sender is set up' };
    try {
      if (kind === 'capture') return { ok: true, detail: 'test capture file' };
      if (kind === 'gmail') {
        const u = new URL(scriptUrl); u.searchParams.set('key', scriptKey);
        const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j?.ok) return { ok: false, detail: `Gmail script ${r.status}: ${j?.error || 'no answer (deploy it as a web app, Execute as: Me, Who has access: Anyone, and use the URL ending in /exec)'}` };
        return { ok: true, detail: `Gmail script ready${j.quota != null ? `, ${j.quota} emails left today` : ''}` };
      }
      if (kind === 'brevo') {
        const r = await fetch(env.BREVO_ACCOUNT_URL || 'https://api.brevo.com/v3/account', { headers: { 'api-key': env.BREVO_API_KEY, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) return { ok: false, detail: `Brevo ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}` };
        return { ok: true, detail: `Brevo ready, sending as ${from}` };
      }
      const port = Number(env.SMTP_PORT) || 465;
      await smtpSend({ host: env.SMTP_HOST, port, secure: env.SMTP_SECURE ? env.SMTP_SECURE !== 'false' : port === 465, user: env.SMTP_USER, pass: env.SMTP_PASS, verifyOnly: true, timeoutMs: 15000 });
      return { ok: true, detail: `SMTP ready (${env.SMTP_HOST}), sending as ${from}` };
    } catch (e) {
      const blocked = kind === 'smtp' && /did not answer|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/.test(`${e.code || ''} ${e.message}`);
      return { ok: false, detail: `${kind}: ${e.message}${blocked ? ' (Railway only allows SMTP on the Pro plan: use the Gmail script, GMAIL_SCRIPT_URL, instead)' : ''}` };
    }
  }
  return { enabled: !!kind, kind, from, send, check };
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const wrap = (s) => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();

function mime({ from, fromName, to, subject, text, html }) {
  const boundary = `vgd-${crypto.randomBytes(8).toString('hex')}`;
  const domain = from.split('@')[1] || 'vangaurd';
  return [
    `From: "${fromName}" <${from}>`,
    `To: <${to}>`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(b64(text)),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(b64(html || text)),
    `--${boundary}--`,
  ].join('\r\n');
}

// A small SMTP client (implicit TLS on 465, STARTTLS on 587, AUTH LOGIN). Bodies are base64, so no line of
// the message ever starts with "." and no dot-stuffing is needed.
export function smtpSend(o) {
  const timeoutMs = o.timeoutMs || 20000;
  return new Promise((resolve, reject) => {
    let sock = null, buf = '', lines = [], waiter = null, done = false;
    const fail = (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { sock?.destroy(); } catch { /* closed */ }
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const timer = setTimeout(() => fail(new Error('the mail server did not answer in time')), timeoutMs);
    const onData = (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        lines.push(line);
        if (/^\d{3}(?: |$)/.test(line)) {
          const reply = { code: Number(line.slice(0, 3)), text: lines.join('\n') };
          lines = [];
          const w = waiter; waiter = null;
          if (w) w(reply);
        }
      }
    };
    const attach = (s) => { sock = s; s.on('data', onData); s.on('error', fail); };
    const expect = (codes) => new Promise((res, rej) => { waiter = (r) => (codes.includes(r.code) ? res(r) : rej(new Error(`mail server said ${r.text.replace(/\s+/g, ' ').slice(0, 160)}`))); });
    const cmd = (line, codes) => { const p = expect(codes); sock.write(line + '\r\n'); return p; };
    (async () => {
      attach(o.secure ? tls.connect({ host: o.host, port: o.port, servername: o.host }) : net.connect({ host: o.host, port: o.port }));
      await expect([220]);
      let ehlo = await cmd('EHLO vangaurd', [250]);
      if (!o.secure && /STARTTLS/i.test(ehlo.text) && o.starttls !== false) {
        await cmd('STARTTLS', [220]);
        sock.removeListener('data', onData);
        const t = tls.connect({ socket: sock, servername: o.host });
        await new Promise((res, rej) => { t.once('secureConnect', res); t.once('error', rej); });
        attach(t);
        ehlo = await cmd('EHLO vangaurd', [250]);
      }
      if (o.user) {
        await cmd('AUTH LOGIN', [334]);
        await cmd(b64(o.user), [334]);
        await cmd(b64(o.pass), [235]);
      }
      if (o.verifyOnly) {
        try { await cmd('QUIT', [221]); } catch { /* fine */ }
        done = true; clearTimeout(timer);
        try { sock.end(); } catch { /* closed */ }
        return resolve({ ok: true });
      }
      await cmd(`MAIL FROM:<${o.from}>`, [250]);
      await cmd(`RCPT TO:<${o.to}>`, [250, 251]);
      await cmd('DATA', [354]);
      await cmd(`${mime(o)}\r\n.`, [250]);
      try { await cmd('QUIT', [221]); } catch { /* fine */ }
      done = true; clearTimeout(timer);
      try { sock.end(); } catch { /* closed */ }
      resolve({ ok: true });
    })().catch(fail);
  });
}

const PURPOSE = {
  register: ['finish creating your Vangaurd account', 'Welcome to Vangaurd'],
  login: ['sign in to Vangaurd', 'Sign-in code'],
  add_email: ['add this email to your Vangaurd account', 'Confirm your email'],
  reset: ['reset your Vangaurd password', 'Password reset'],
};
export function codeEmail(to, code, purpose, username = '') {
  const [what, title] = PURPOSE[purpose] || PURPOSE.login;
  const who = username ? ` (${username})` : '';
  const text = `Your Vangaurd code is ${code}\n\nUse it to ${what}${who}. It expires in 10 minutes.\n\nIf you didn't ask for this code, you can ignore this email. Nobody can get into the account without it.\n\nVangaurd`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#0b0e10;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#e9ece6">
<div style="max-width:440px;margin:0 auto;background:#12171b;border:1px solid #262d33;border-top:3px solid #f2c14e;padding:28px">
<div style="font-weight:800;letter-spacing:.3em;font-size:18px">VANGAURD</div>
<div style="color:#f2c14e;font-size:11px;font-weight:700;letter-spacing:.24em;text-transform:uppercase;margin-top:4px">${title}</div>
<p style="margin:22px 0 10px;color:#b9bfb8;font-size:14px;line-height:1.5">Use this code to ${what}${who}:</p>
<div style="font-size:34px;font-weight:800;letter-spacing:.32em;color:#ffffff;background:#0b0e10;border:1px solid #2c343a;padding:14px 0;text-align:center">${code}</div>
<p style="margin:16px 0 0;color:#8e968f;font-size:12px;line-height:1.5">It expires in 10 minutes. If you didn't ask for this code, ignore this email. Nobody can get into the account without it.</p>
</div></body></html>`;
  return { to, subject: `Your Vangaurd code: ${code}`, text, html, code, purpose, username };
}
