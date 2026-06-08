// Envio de e-mail via Microsoft Graph (`POST /users/{EMAIL_SENDER}/sendMail`).
// Caixa remetente vem do .env (EMAIL_SENDER), default cobranca@gnatus.com.br.
// App registration precisa de Mail.Send (application) com admin consent — ideal
// restringido por Application Access Policy a essa caixa.
//
// Em DEV (NODE_ENV != 'production') so loga no console — nao envia. Util pra
// testes sem precisar de credencial / sem mandar e-mail real.

const m365 = require('./m365');

const isDev = process.env.NODE_ENV !== 'production';
// Remetente PADRAO de toda a intranet (e-mails internos: boas-vindas, reset,
// alertas, cofre). Hoje = ti@gnatus.com.br (via .env EMAIL_SENDER).
const SENDER = process.env.EMAIL_SENDER || 'ti@gnatus.com.br';
// Remetente da COBRANCA (e-mails ao cliente: boletos). Fixo em cobranca@ pra
// o cliente receber/responder na caixa certa, independente do remetente global.
const SENDER_COBRANCA = process.env.EMAIL_SENDER_COBRANCA || 'cobranca@gnatus.com.br';

async function sendVerificationEmail(to, codigo) {
    if (isDev) {
        console.log(`[emailService] DEV — código pra ${to}: ${codigo}`);
        return { dev: true };
    }
    return await m365.sendMail({
        from: SENDER,
        to,
        subject: 'Código de redefinição de senha',
        text: `Seu código de verificação é: ${codigo}\nVálido por 15 minutos.`
    });
}

// Envio generico — usado pelos modulos que mandam e-mail livre (alertas de
// contrato, boleto-disparar, etc). O m365.sendMail trata strings com ',' ou
// ';' como multiplos destinatarios.
async function sendEmail({ to, subject, text, html, cc, bcc, attachments, from }) {
    if (!to) throw new Error('Destinatario obrigatorio.');
    const remetente = from || SENDER;
    if (isDev) {
        const anexos = Array.isArray(attachments) ? attachments.length : 0;
        console.log(`[emailService] DEV — email de ${remetente} pra ${to}: "${subject}"${anexos ? ` (${anexos} anexo(s))` : ''}`);
        return { dev: true };
    }
    return await m365.sendMail({ from: remetente, to, cc, bcc, subject, text, html, attachments });
}

module.exports = { sendVerificationEmail, sendEmail, SENDER, SENDER_COBRANCA };
