import nodemailer from 'nodemailer';

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

const FROM_NAME = 'GCIG';

function from() {
  return `${FROM_NAME} <${process.env.GMAIL_USER}>`;
}

export async function sendVerificationCode(toEmail, code) {
  await getTransporter().sendMail({
    from: from(),
    to: toEmail,
    subject: `GCIG Verification Code: ${code}`,
    html: `
      <div style="font-family: 'Inter', system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #1B2A4A; font-size: 24px; margin: 0;">GCIG</h1>
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
          <h1 style="color: #1B2A4A; font-size: 24px; margin: 0;">GCIG</h1>
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
            Open GCIG
          </a>
        </div>
      </div>
    `,
  });
}

export async function sendInviteEmail(toEmail, { name, role, inviteUrl }) {
  await getTransporter().sendMail({
    from: from(),
    to: toEmail,
    subject: `You've been invited to GCIG`,
    html: `
      <div style="font-family: 'Inter', system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #1B2A4A; font-size: 24px; margin: 0;">GCIG</h1>
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
