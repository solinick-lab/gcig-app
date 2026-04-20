import nodemailer from 'nodemailer';

// Canonical URL used when building user-facing links (invites, password
// resets, pitch notifications). Order of precedence:
//   1. PUBLIC_URL env var — explicitly set to the production domain
//   2. First entry of CLIENT_ORIGIN (the CORS list)
//   3. The hardcoded production domain
// Also strips trailing slashes and repairs the common `https//` typo.
export function primaryClientOrigin(fallback = 'https://thegriffinfund.org') {
  const raw =
    process.env.PUBLIC_URL || process.env.CLIENT_ORIGIN || fallback;
  const first = String(raw).split(',')[0].trim();
  if (!first) return fallback;
  const repaired = first
    .replace(/^https\/\//i, 'https://')
    .replace(/^http\/\//i, 'http://');
  return repaired.replace(/\/+$/, '');
}

let transporter = null;

function getTransporter() {
  if (!transporter) {
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD must be set in .env');
    }
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }
  return transporter;
}

const FROM_NAME = 'The Griffin Fund';

function from() {
  return `${FROM_NAME} <${process.env.GMAIL_USER}>`;
}

export async function sendVerificationCode(toEmail, code) {
  await getTransporter().sendMail({
    from: from(),
    to: toEmail,
    subject: `Griffin Fund Verification Code: ${code}`,
    html: `
      <div style="font-family: 'Inter', system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #1B2A4A; font-size: 20px; margin: 0; font-family: Georgia, serif; letter-spacing: -0.01em;">The Griffin Fund</h1>
          <p style="color: #C9A84C; font-size: 11px; text-transform: uppercase; letter-spacing: 2px; margin: 4px 0 0;">
            Grace Church School Investment Group
          </p>
        </div>
        <div style="background: #F7F8FB; border-radius: 12px; padding: 24px; text-align: center;">
          <p style="color: #1B2A4A; font-size: 14px; margin: 0 0 16px;">
            Your verification code is:
          </p>
          <div style="background: #1B2A4A; color: #C9A84C; font-size: 32px; font-weight: 700; letter-spacing: 8px; padding: 16px 24px; border-radius: 8px; display: inline-block;">
            ${code}
          </div>
          <p style="color: #8C99BB; font-size: 12px; margin: 16px 0 0;">
            This code expires in 10 minutes. If you didn't request this, ignore this email.
          </p>
        </div>
      </div>
    `,
  });
}

export async function sendNewDeviceLoginEmail(toEmail, { name, ip, userAgent, when }) {
  await getTransporter().sendMail({
    from: from(),
    to: toEmail,
    subject: 'New sign-in to your Griffin Fund account',
    html: `
      <div style="font-family: 'Inter', system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #1B2A4A; font-size: 20px; margin: 0; font-family: Georgia, serif; letter-spacing: -0.01em;">The Griffin Fund</h1>
          <p style="color: #C9A84C; font-size: 11px; text-transform: uppercase; letter-spacing: 2px; margin: 4px 0 0;">
            Grace Church School Investment Group
          </p>
        </div>
        <div style="background: #F7F8FB; border-radius: 12px; padding: 24px;">
          <p style="color: #1B2A4A; font-size: 14px; margin: 0 0 8px;">Hi ${name},</p>
          <p style="color: #1B2A4A; font-size: 14px; margin: 0 0 16px;">
            Your Griffin Fund account was just signed in from a device we haven't seen before. If this was you, you can ignore this email.
          </p>
          <div style="background: #1B2A4A; border-radius: 8px; padding: 16px; margin: 0 0 16px;">
            <p style="color: #8C99BB; font-size: 12px; margin: 0 0 4px;">When</p>
            <p style="color: white; font-size: 13px; margin: 0 0 12px;">${when}</p>
            <p style="color: #8C99BB; font-size: 12px; margin: 0 0 4px;">IP Address</p>
            <p style="color: white; font-size: 13px; font-family: monospace; margin: 0 0 12px;">${ip || 'unknown'}</p>
            <p style="color: #8C99BB; font-size: 12px; margin: 0 0 4px;">Browser</p>
            <p style="color: white; font-size: 12px; margin: 0;">${userAgent || 'unknown'}</p>
          </div>
          <p style="color: #1B2A4A; font-size: 14px; margin: 0 0 8px;">
            <strong>Didn't recognize this?</strong>
          </p>
          <ol style="color: #1B2A4A; font-size: 13px; padding-left: 20px; margin: 0;">
            <li style="margin-bottom: 4px;">Change your password immediately</li>
            <li style="margin-bottom: 4px;">Sign out of every device from your Profile page</li>
            <li style="margin-bottom: 4px;">Enable 2FA if you haven't already</li>
          </ol>
        </div>
      </div>
    `,
  });
}

export async function sendTwoFactorCodeEmail(toEmail, { name, code, purpose = 'login' }) {
  const display = `${code.slice(0, 4)}-${code.slice(4, 8)}`;
  const subject =
    purpose === 'setup'
      ? `Confirm 2FA setup: ${display}`
      : `Griffin Fund sign-in code: ${display}`;
  const intro =
    purpose === 'setup'
      ? 'Enter this code to finish setting up email 2FA on your account.'
      : 'Enter this code to finish signing in.';
  await getTransporter().sendMail({
    from: from(),
    to: toEmail,
    subject,
    html: `
      <div style="font-family: 'Inter', system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #1B2A4A; font-size: 20px; margin: 0; font-family: Georgia, serif; letter-spacing: -0.01em;">The Griffin Fund</h1>
          <p style="color: #C9A84C; font-size: 11px; text-transform: uppercase; letter-spacing: 2px; margin: 4px 0 0;">
            Grace Church School Investment Group
          </p>
        </div>
        <div style="background: #F7F8FB; border-radius: 12px; padding: 24px; text-align: center;">
          ${name ? `<p style="color: #1B2A4A; font-size: 14px; margin: 0 0 8px;">Hi ${name},</p>` : ''}
          <p style="color: #1B2A4A; font-size: 14px; margin: 0 0 16px;">${intro}</p>
          <div style="background: #1B2A4A; color: #C9A84C; font-size: 26px; font-weight: 700; letter-spacing: 6px; padding: 16px 24px; border-radius: 8px; display: inline-block; font-family: monospace;">
            ${display}
          </div>
          <p style="color: #8C99BB; font-size: 12px; margin: 16px 0 0;">
            This code expires in 10 minutes. If you didn't request this, someone may be trying to access your account — change your password.
          </p>
        </div>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail(toEmail, { name, resetUrl }) {
  await getTransporter().sendMail({
    from: from(),
    to: toEmail,
    subject: 'Reset your Griffin Fund password',
    html: `
      <div style="font-family: 'Inter', system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #1B2A4A; font-size: 20px; margin: 0; font-family: Georgia, serif; letter-spacing: -0.01em;">The Griffin Fund</h1>
          <p style="color: #C9A84C; font-size: 11px; text-transform: uppercase; letter-spacing: 2px; margin: 4px 0 0;">
            Grace Church School Investment Group
          </p>
        </div>
        <div style="background: #F7F8FB; border-radius: 12px; padding: 24px;">
          <p style="color: #1B2A4A; font-size: 14px; margin: 0 0 8px;">Hi ${name},</p>
          <p style="color: #1B2A4A; font-size: 14px; margin: 0 0 16px;">
            Someone requested a password reset for your Griffin Fund account. If this was you, click below to set a new password:
          </p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${resetUrl}" style="display: inline-block; background: #C9A84C; color: #1B2A4A; font-size: 14px; font-weight: 600; text-decoration: none; padding: 12px 32px; border-radius: 8px;">
              Reset Password
            </a>
          </div>
          <p style="color: #8C99BB; font-size: 12px; margin: 16px 0 0;">
            This link expires in 30 minutes. If you didn't request a reset, ignore this email — your password is unchanged.
          </p>
          <p style="color: #1B2A4A; font-size: 11px; font-family: monospace; word-break: break-all; margin: 8px 0 0;">
            ${resetUrl}
          </p>
        </div>
      </div>
    `,
  });
}

export async function sendPitchAssignmentEmail(
  toEmail,
  { name, ticker, pitcherDisplay, date, location, dashboardUrl }
) {
  const dateStr = new Date(date).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  await getTransporter().sendMail({
    from: from(),
    to: toEmail,
    subject: `You've been added to the ${ticker} pitch`,
    html: `
      <div style="font-family: 'Inter', system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #1B2A4A; font-size: 20px; margin: 0; font-family: Georgia, serif; letter-spacing: -0.01em;">The Griffin Fund</h1>
          <p style="color: #C9A84C; font-size: 11px; text-transform: uppercase; letter-spacing: 2px; margin: 4px 0 0;">
            Grace Church School Investment Group
          </p>
        </div>
        <div style="background: #F7F8FB; border-radius: 12px; padding: 24px;">
          <p style="color: #1B2A4A; font-size: 14px; margin: 0 0 8px;">Hi ${name},</p>
          <p style="color: #1B2A4A; font-size: 14px; margin: 0 0 16px;">
            You've been added as a presenter on the <strong>${ticker}</strong> pitch.
          </p>
          <div style="background: #1B2A4A; border-radius: 8px; padding: 16px; margin: 0 0 16px;">
            <p style="color: #8C99BB; font-size: 12px; margin: 0 0 4px;">Ticker</p>
            <p style="color: #C9A84C; font-size: 20px; font-weight: 700; margin: 0 0 12px;">${ticker}</p>
            <p style="color: #8C99BB; font-size: 12px; margin: 0 0 4px;">Presenters</p>
            <p style="color: white; font-size: 13px; margin: 0 0 12px;">${pitcherDisplay}</p>
            <p style="color: #8C99BB; font-size: 12px; margin: 0 0 4px;">When</p>
            <p style="color: white; font-size: 13px; margin: 0 0 ${location ? '12px' : '0'};">${dateStr}</p>
            ${
              location
                ? `<p style="color: #8C99BB; font-size: 12px; margin: 0 0 4px;">Location</p>
                   <p style="color: white; font-size: 13px; margin: 0;">${location}</p>`
                : ''
            }
          </div>
          <a href="${dashboardUrl}" style="display: inline-block; background: #C9A84C; color: #1B2A4A; font-size: 14px; font-weight: 600; text-decoration: none; padding: 10px 24px; border-radius: 8px;">
            Open the Griffin Fund
          </a>
        </div>
      </div>
    `,
  });
}

// Broadcast email sent by CIO+ to a group of members. Recipients go in BCC so
// everyone stays private. `bodyHtml` is pre-escaped HTML (the route converts
// newlines → <br> so the sender doesn't need to know HTML). `senderName` is
// rendered as a human "from" line inside the template.
export async function sendBroadcastEmail(
  toEmails,
  { subject, bodyHtml, senderName, audienceLabel }
) {
  if (!Array.isArray(toEmails) || toEmails.length === 0) {
    throw new Error('No recipients');
  }
  await getTransporter().sendMail({
    from: from(),
    to: from(), // our own address — recipients are bcc'd
    bcc: toEmails,
    subject,
    html: `
      <div style="font-family: 'Inter', system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #1B2A4A; font-size: 20px; margin: 0; font-family: Georgia, serif; letter-spacing: -0.01em;">The Griffin Fund</h1>
          <p style="color: #C9A84C; font-size: 11px; text-transform: uppercase; letter-spacing: 2px; margin: 4px 0 0;">
            Grace Church School Investment Group
          </p>
        </div>
        <div style="background: #F7F8FB; border-radius: 12px; padding: 24px;">
          <div style="color: #8C99BB; font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; margin: 0 0 4px;">
            From
          </div>
          <div style="color: #1B2A4A; font-size: 14px; font-weight: 600; margin: 0 0 12px;">
            ${senderName}${audienceLabel ? ` &middot; to ${audienceLabel}` : ''}
          </div>
          <div style="color: #1B2A4A; font-size: 15px; line-height: 1.55; white-space: pre-wrap;">
            ${bodyHtml}
          </div>
        </div>
        <p style="color: #8C99BB; font-size: 11px; text-align: center; margin: 16px 0 0;">
          You received this because you are a member of the Griffin Fund. Replies go to ${senderName}.
        </p>
      </div>
    `,
  });
}

export async function sendInviteEmail(toEmail, { name, role, inviteUrl }) {
  await getTransporter().sendMail({
    from: from(),
    to: toEmail,
    subject: `You've been invited to the Griffin Fund`,
    html: `
      <div style="font-family: 'Inter', system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #1B2A4A; font-size: 20px; margin: 0; font-family: Georgia, serif; letter-spacing: -0.01em;">The Griffin Fund</h1>
          <p style="color: #C9A84C; font-size: 11px; text-transform: uppercase; letter-spacing: 2px; margin: 4px 0 0;">
            Grace Church School Investment Group
          </p>
        </div>
        <div style="background: #F7F8FB; border-radius: 12px; padding: 24px;">
          <p style="color: #1B2A4A; font-size: 14px; margin: 0 0 8px;">
            Hi ${name},
          </p>
          <p style="color: #1B2A4A; font-size: 14px; margin: 0 0 16px;">
            You've been invited to join the Grace Church School Investment Group as a <strong>${role}</strong>. Click below to set your password and activate your account.
          </p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${inviteUrl}" style="display: inline-block; background: #C9A84C; color: #1B2A4A; font-size: 14px; font-weight: 600; text-decoration: none; padding: 12px 32px; border-radius: 8px;">
              Set Up Your Account
            </a>
          </div>
          <p style="color: #8C99BB; font-size: 12px; margin: 16px 0 0;">
            This link expires in 7 days. If the button doesn't work, copy and paste this URL into your browser:
          </p>
          <p style="color: #1B2A4A; font-size: 11px; font-family: monospace; word-break: break-all; margin: 8px 0 0;">
            ${inviteUrl}
          </p>
        </div>
      </div>
    `,
  });
}
