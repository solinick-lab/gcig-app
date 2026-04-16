import { Resend } from 'resend';

let resend = null;

function getResend() {
  if (!resend) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is not set in .env');
    }
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

const FROM =
  process.env.RESEND_FROM_EMAIL || 'GCIG <onboarding@resend.dev>';

export async function sendVerificationCode(toEmail, code) {
  const { error } = await getResend().emails.send({
    from: FROM,
    to: [toEmail],
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

  if (error) {
    console.error('Resend email error:', error);
    throw new Error(`Failed to send verification email: ${error.message}`);
  }
}

export async function sendInviteEmail(toEmail, { name, tempPassword, role, loginUrl }) {
  const { error } = await getResend().emails.send({
    from: FROM,
    to: [toEmail],
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
            You've been added to the Grace Church School Investment Group as a <strong>${role}</strong>. Here are your login credentials:
          </p>
          <div style="background: #1B2A4A; border-radius: 8px; padding: 16px; margin: 0 0 16px;">
            <p style="color: #8C99BB; font-size: 12px; margin: 0 0 4px;">Email</p>
            <p style="color: white; font-size: 14px; font-weight: 600; margin: 0 0 12px;">${toEmail}</p>
            <p style="color: #8C99BB; font-size: 12px; margin: 0 0 4px;">Temporary Password</p>
            <p style="color: #C9A84C; font-size: 18px; font-weight: 700; font-family: monospace; margin: 0;">${tempPassword}</p>
          </div>
          <a href="${loginUrl}" style="display: inline-block; background: #C9A84C; color: #1B2A4A; font-size: 14px; font-weight: 600; text-decoration: none; padding: 10px 24px; border-radius: 8px;">
            Sign in to GCIG
          </a>
          <p style="color: #8C99BB; font-size: 12px; margin: 16px 0 0;">
            Please change your password after your first login by going to Profile → Change Password.
          </p>
        </div>
      </div>
    `,
  });

  if (error) {
    console.error('Resend invite email error:', error);
    throw new Error(`Failed to send invite email: ${error.message}`);
  }
}
