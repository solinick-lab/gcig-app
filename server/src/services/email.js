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

// Pitch-request notification sent to the President + the relevant
// industry PM at submission time, plus a confirmation copy back to the
// requester so they know it went through. `attachment` is optional —
// when the requester uploaded a deck via OneDrive we attach the bytes;
// when they pasted a Google Drive / Slides URL we just embed the link.
export async function sendPitchRequestEmail(
  toEmail,
  {
    recipientName,
    recipientRole, // 'President' | 'PM' | 'Requester'
    requesterName,
    requesterRole,
    ticker,
    companyName,
    industryName,
    proposedDate,
    proposedLunch,
    proposedStartTime, // "HH:MM" — pretty-printed in the body
    room, // 'LIBRARY' | 'LOWER_COMMONS' | 'ATHLETIC_COMMONS'
    notes,
    deckUrl, // External URL when deck wasn't uploaded
    deckFileName, // For the body when we have an attachment
    inboxUrl,
    attachment, // { filename, content (Buffer), contentType }
  }
) {
  const dateStr = proposedDate
    ? new Date(proposedDate).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : 'No date proposed';
  const lunchLabel = proposedLunch
    ? proposedLunch === 'Both'
      ? 'either lunch'
      : `${proposedLunch.toLowerCase()} lunch`
    : null;
  const timeLabel = formatHHMMto12h(proposedStartTime);
  const roomLabel = roomLabelFor(room);
  // Per-recipient greeting + framing copy. President / PM get the
  // existing "this is for you to act on" framing; Requester gets a
  // short confirmation that the request went through.
  const audienceCopy =
    recipientRole === 'President'
      ? `<strong>${requesterName}</strong> has requested a pitch meeting with you.`
      : recipientRole === 'PM'
      ? `<strong>${requesterName}</strong> (one of your pod members) has requested a pitch meeting with the President. You're cc'd as the responsible portfolio manager.`
      : `Your pitch request was submitted. The President will review it shortly — we've cc'd your sector PM for awareness.`;
  const deckBlock = attachment
    ? `<p style="color: #1B2A4A; font-size: 13px; margin: 0 0 4px;">
         <strong>Slide deck:</strong> attached (${attachment.filename})
       </p>`
    : deckUrl
    ? `<p style="color: #1B2A4A; font-size: 13px; margin: 0 0 4px;">
         <strong>Slide deck:</strong>
         <a href="${deckUrl}" style="color: #1B2A4A;">${deckFileName || deckUrl}</a>
       </p>`
    : '';

  const mail = {
    from: from(),
    to: toEmail,
    subject:
      recipientRole === 'Requester'
        ? `Submitted: your ${ticker}${companyName ? ` (${companyName})` : ''} pitch request`
        : `Pitch request: ${ticker}${companyName ? ` (${companyName})` : ''} from ${requesterName}`,
    html: `
      <div style="font-family: 'Inter', system-ui, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #1B2A4A; font-size: 20px; margin: 0; font-family: Georgia, serif; letter-spacing: -0.01em;">The Griffin Fund</h1>
          <p style="color: #C9A84C; font-size: 11px; text-transform: uppercase; letter-spacing: 2px; margin: 4px 0 0;">
            Grace Church School Investment Group
          </p>
        </div>
        <div style="background: #F7F8FB; border-radius: 12px; padding: 24px;">
          <p style="color: #1B2A4A; font-size: 14px; margin: 0 0 8px;">Hi ${recipientName},</p>
          <p style="color: #1B2A4A; font-size: 14px; margin: 0 0 16px;">
            ${audienceCopy}
          </p>
          <div style="background: #1B2A4A; border-radius: 8px; padding: 16px; margin: 0 0 16px;">
            <p style="color: #8C99BB; font-size: 12px; margin: 0 0 4px;">Ticker</p>
            <p style="color: #C9A84C; font-size: 22px; font-weight: 700; margin: 0 0 12px;">${ticker}${companyName ? ` <span style="color: white; font-size: 14px; font-weight: 400;">— ${companyName}</span>` : ''}</p>
            <p style="color: #8C99BB; font-size: 12px; margin: 0 0 4px;">Requested by</p>
            <p style="color: white; font-size: 13px; margin: 0 0 12px;">${requesterName}${requesterRole ? ` <span style="color: #8C99BB;">(${requesterRole})</span>` : ''}</p>
            ${
              industryName
                ? `<p style="color: #8C99BB; font-size: 12px; margin: 0 0 4px;">Sector</p>
                   <p style="color: white; font-size: 13px; margin: 0 0 12px;">${industryName}</p>`
                : ''
            }
            <p style="color: #8C99BB; font-size: 12px; margin: 0 0 4px;">Proposed meeting</p>
            <p style="color: white; font-size: 13px; margin: 0 0 4px;">${dateStr}${lunchLabel ? ` &middot; ${lunchLabel}` : ''}</p>
            <p style="color: white; font-size: 13px; margin: 0 0 ${notes ? '12px' : '0'};">${timeLabel ? `${timeLabel}` : ''}${timeLabel && roomLabel ? ' &middot; ' : ''}${roomLabel ? `${roomLabel}` : ''}</p>
            ${
              notes
                ? `<p style="color: #8C99BB; font-size: 12px; margin: 0 0 4px;">Notes</p>
                   <p style="color: white; font-size: 13px; margin: 0; white-space: pre-wrap;">${escapeHtml(notes)}</p>`
                : ''
            }
          </div>
          ${deckBlock}
          ${
            recipientRole === 'President'
              ? `<p style="color: #1B2A4A; font-size: 14px; margin: 16px 0 8px;">
                   The PM has been cc'd. The request is pending your approval —
                   only your decision blocks the meeting.
                 </p>`
              : recipientRole === 'PM'
              ? `<p style="color: #1B2A4A; font-size: 14px; margin: 16px 0 8px;">
                   Heads up — your approval is informational. The President's
                   decision is what locks in the meeting.
                 </p>`
              : `<p style="color: #1B2A4A; font-size: 14px; margin: 16px 0 8px;">
                   We'll email you again once the President responds. You can
                   also track the status on your dashboard.
                 </p>`
          }
          <div style="text-align: center; margin: 20px 0 0;">
            <a href="${inboxUrl}" style="display: inline-block; background: #C9A84C; color: #1B2A4A; font-size: 14px; font-weight: 600; text-decoration: none; padding: 10px 24px; border-radius: 8px;">
              ${recipientRole === 'Requester' ? 'View on the Griffin Fund' : 'Review on the Griffin Fund'}
            </a>
          </div>
        </div>
      </div>
    `,
  };
  if (attachment) {
    mail.attachments = [
      {
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
      },
    ];
  }
  await getTransporter().sendMail(mail);
}

// Sent to the requester when the President OR a PM acts on their
// request, and (on approval) also sent to the PM as a "for your
// awareness" cc. `decision` is normalized to lowercase before
// comparing so callers passing 'Approved' / 'Declined' / 'approved'
// all work — historically only the lowercase form matched.
export async function sendPitchRequestDecisionEmail(
  toEmail,
  {
    requesterName,
    actor,
    actorName,
    decision, // 'Approved' | 'Declined' (case-insensitive)
    ticker,
    reason,
    dashboardUrl,
    proposedDate, // optional — when present, render the meeting block
    proposedStartTime,
    roomLabel,
    icsAttachment, // optional { filename, content (Buffer or string), contentType }
    ccCopy, // when true, this is the PM's cc copy of an approval
  }
) {
  const isApproved = String(decision || '').toLowerCase() === 'approved';
  const headline = ccCopy
    ? `Confirmed: ${ticker} pitch meeting on the calendar`
    : actor === 'President'
    ? isApproved
      ? `Approved: your ${ticker} pitch request`
      : `Declined: your ${ticker} pitch request`
    : isApproved
    ? `Your PM has approved your ${ticker} pitch request`
    : `Your PM can't make your ${ticker} pitch meeting`;
  const body = ccCopy
    ? `<strong>${actorName}</strong> approved the pitch meeting. You're cc'd as the responsible PM — see the time + room below and add it to your calendar.`
    : actor === 'President'
    ? isApproved
      ? `<strong>${actorName}</strong> approved your pitch request. The meeting is on — see the details below, and the attached calendar invite will drop it onto your Gmail / Apple / Outlook calendar.`
      : `<strong>${actorName}</strong> declined your pitch request.${reason ? ` Reason: <em>${escapeHtml(reason)}</em>` : ''} You can submit a new request with a different time or refined thesis.`
    : isApproved
    ? `<strong>${actorName}</strong> (your PM) approved the request. The President's decision is still pending.`
    : `<strong>${actorName}</strong> (your PM) can't make this meeting${reason ? ` — <em>${escapeHtml(reason)}</em>` : ''}. The President can still approve, so the meeting may go ahead without your PM.`;

  // Meeting details block — only rendered when we have a date AND a
  // start time (i.e. on approve emails, where it matters most).
  const dateStr = proposedDate
    ? new Date(proposedDate).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : null;
  const timeLabel = formatHHMMto12h(proposedStartTime);
  const showDetails = isApproved && dateStr && timeLabel;
  const detailsBlock = showDetails
    ? `<div style="background: #1B2A4A; border-radius: 8px; padding: 16px; margin: 0 0 16px;">
         <p style="color: #8C99BB; font-size: 12px; margin: 0 0 4px;">When</p>
         <p style="color: white; font-size: 13px; margin: 0 0 12px;">${dateStr} &middot; ${timeLabel}</p>
         ${
           roomLabel
             ? `<p style="color: #8C99BB; font-size: 12px; margin: 0 0 4px;">Where</p>
                <p style="color: white; font-size: 13px; margin: 0;">${escapeHtml(roomLabel)}</p>`
             : ''
         }
       </div>`
    : '';

  const mail = {
    from: from(),
    to: toEmail,
    subject: headline,
    html: `
      <div style="font-family: 'Inter', system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #1B2A4A; font-size: 20px; margin: 0; font-family: Georgia, serif; letter-spacing: -0.01em;">The Griffin Fund</h1>
          <p style="color: #C9A84C; font-size: 11px; text-transform: uppercase; letter-spacing: 2px; margin: 4px 0 0;">
            Grace Church School Investment Group
          </p>
        </div>
        <div style="background: #F7F8FB; border-radius: 12px; padding: 24px;">
          <p style="color: #1B2A4A; font-size: 14px; margin: 0 0 8px;">Hi ${requesterName},</p>
          <p style="color: #1B2A4A; font-size: 14px; margin: 0 0 16px;">${body}</p>
          ${detailsBlock}
          <div style="text-align: center; margin: 20px 0 0;">
            <a href="${dashboardUrl}" style="display: inline-block; background: #C9A84C; color: #1B2A4A; font-size: 14px; font-weight: 600; text-decoration: none; padding: 10px 24px; border-radius: 8px;">
              Open the Griffin Fund
            </a>
          </div>
        </div>
      </div>
    `,
  };
  if (icsAttachment) {
    mail.attachments = [
      {
        filename: icsAttachment.filename || 'pitch-meeting.ics',
        content: icsAttachment.content,
        contentType: icsAttachment.contentType || 'text/calendar; charset=utf-8',
      },
    ];
  }
  await getTransporter().sendMail(mail);
}

// Tiny iCalendar (.ics) builder for approved pitch meetings. No
// dependencies — RFC5545 is forgiving enough that we can hand-roll
// this in 30 lines. Date/time are anchored to America/New_York since
// every Grace Church School lunch period happens in ET regardless of
// where the requester opens the email.
export function buildPitchMeetingIcs({
  uid,
  proposedDate, // Date or ISO string
  proposedStartTime, // "HH:MM"
  durationMinutes = 30,
  ticker,
  companyName,
  roomLabel,
  organizerEmail,
  organizerName,
  attendeeEmails = [],
}) {
  if (!proposedDate || !proposedStartTime) {
    throw new Error('proposedDate + proposedStartTime required');
  }
  const [hh, mm] = proposedStartTime.split(':').map(Number);
  // `proposedDate` may have a time component baked in; we only want
  // the calendar day, then attach the lunch start time.
  const day = new Date(proposedDate);
  if (Number.isNaN(day.getTime())) throw new Error('Invalid proposedDate');
  // UTC accessors so "2026-04-29" stays April 29 regardless of the
  // server's timezone — see lunchSlots.weekdayKeyFor for the same
  // reasoning.
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth() + 1;
  const d = day.getUTCDate();
  // Render as TZID=America/New_York wall-clock — most clients handle
  // this without a VTIMEZONE block when the TZID is well-known.
  const pad = (n) => String(n).padStart(2, '0');
  const startWallclock = `${y}${pad(m)}${pad(d)}T${pad(hh)}${pad(mm)}00`;
  const endMinutes = hh * 60 + mm + durationMinutes;
  const endHh = Math.floor(endMinutes / 60);
  const endMm = endMinutes % 60;
  const endWallclock = `${y}${pad(m)}${pad(d)}T${pad(endHh)}${pad(endMm)}00`;
  const dtstamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const summary = `Pitch meeting · ${ticker}${companyName ? ` (${companyName})` : ''}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Griffin Fund//Pitch Request//EN',
    'METHOD:REQUEST',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;TZID=America/New_York:${startWallclock}`,
    `DTEND;TZID=America/New_York:${endWallclock}`,
    `SUMMARY:${icsEscape(summary)}`,
    roomLabel ? `LOCATION:${icsEscape(roomLabel)}` : null,
    organizerEmail
      ? `ORGANIZER;CN=${icsEscape(organizerName || 'President')}:mailto:${organizerEmail}`
      : null,
    ...attendeeEmails
      .filter(Boolean)
      .map(
        (e) =>
          `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${e}`
      ),
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return {
    filename: 'pitch-meeting.ics',
    content: lines.join('\r\n'),
    contentType: 'text/calendar; charset=utf-8; method=REQUEST',
  };
}

function icsEscape(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

// Pretty-print "12:15" → "12:15 PM". Returns empty string for falsy
// input so template `${...}` interpolation stays clean.
function formatHHMMto12h(hhmm) {
  if (!/^\d{2}:\d{2}$/.test(hhmm || '')) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

// Friendly room name for the request emails. Keep this aligned with
// `ROOM_LABELS` in `src/lib/lunchSlots.js` — duplicating the small map
// here avoids the email service depending on the lunchSlots module.
function roomLabelFor(room) {
  if (!room) return null;
  const map = {
    LIBRARY: 'Library (near smart board / printers)',
    LOWER_COMMONS: 'Lower Commons',
    ATHLETIC_COMMONS: 'Athletic Commons',
  };
  return map[room] || room;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
