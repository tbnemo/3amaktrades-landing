// Standing template for one-off giveaway/prize-winner emails (FundingPips
// giveaways and whatever comes after). Reuses _email.js's Resend transport
// and Minimal Ticket shell rather than a second copy of either -- this is a
// different AUDIENCE from bookings, not a different visual identity.
const { send, shell, headline, detailsBox, footerLine, escapeHtml } = require('./_email');

const DEFAULT_PRIZE = '5K 2-Step Pro';

async function sendPrizeWinnerNotice({ email, name, code, prize }) {
  const greetName = (name && String(name).trim()) || 'there';
  const prizeLabel = (prize && String(prize).trim()) || DEFAULT_PRIZE;
  const html = shell(`
    ${headline('YOU WON THE<br>GIVEAWAY 🎉', 'en')}
    <p style="color:#F2EEE4;font-size:14px;margin:0 0 16px;">Hi ${escapeHtml(greetName)}, congrats on winning! Claim your prize with the code below.</p>
    ${detailsBox([{
      label: 'YOUR CODE',
      value: `<span style="font-family:monospace;letter-spacing:1px;">${escapeHtml(code)}</span>`,
      color: '#D4AF37',
    }], 'en')}
    <p style="color:#F2EEE4;font-size:14px;margin:0 0 16px;">Head to the FundingPips app checkout and select the <strong>${escapeHtml(prizeLabel)}</strong> account, then apply your code at checkout.</p>
    <p style="color:#8B887F;font-size:12px;margin:0 0 16px;">This code is strictly one-time use and only works on the ${escapeHtml(prizeLabel)} account &mdash; double check the account type before you check out.</p>
    ${footerLine('Questions?', 'Message us on WhatsApp')}
  `, 'en');
  return send({ to: email, subject: 'You Won the FundingPips Giveaway! 🎉', html });
}

module.exports = { sendPrizeWinnerNotice, DEFAULT_PRIZE };
