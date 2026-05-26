const nodemailer = require('nodemailer');

const isDev = process.env.NODE_ENV !== 'production';

const transporter = nodemailer.createTransport(
    isDev
        ? { host: 'localhost', port: 1025, ignoreTLS: true }
        : {
              host: process.env.SMTP_HOST,
              port: Number(process.env.SMTP_PORT) || 587,
              secure: process.env.SMTP_SECURE === 'true',
              auth: {
                  user: process.env.SMTP_USER,
                  pass: process.env.SMTP_PASS,
              },
          }
);

async function sendVerificationEmail(to, codigo) {
    if (isDev) {
        console.log(`[emailService] DEV — código para ${to}: ${codigo}`);
        return;
    }

    await transporter.sendMail({
        from: process.env.SMTP_FROM || 'noreply@intranet.local',
        to,
        subject: 'Código de redefinição de senha',
        text: `Seu código de verificação é: ${codigo}\nVálido por 15 minutos.`,
    });
}

// Quebra um campo de destinatarios em array, aceitando separadores ',' e ';'
// (o SA1 do Protheus guarda multiplos e-mails separados por ';' — convencao
// Outlook — e o nodemailer interpretaria como UM endereco invalido se passado
// como string). Devolve a entrada como esta se ja for array, ou null/undefined.
const splitAddrs = (v) => {
    if (v == null || v === '') return v;
    if (Array.isArray(v)) return v;
    return String(v).split(/[;,]/).map(s => s.trim()).filter(Boolean);
};

// Envio generico — usado por modulos que precisam mandar e-mail livre
// (alertas de contrato, notificacoes diversas, etc).
async function sendEmail({ to, subject, text, html, cc, bcc }) {
    if (!to) throw new Error('Destinatario obrigatorio.');
    if (isDev) {
        console.log(`[emailService] DEV — email pra ${to}: "${subject}"`);
        return { dev: true };
    }
    const info = await transporter.sendMail({
        from: process.env.SMTP_FROM || 'noreply@intranet.local',
        to: splitAddrs(to), cc: splitAddrs(cc), bcc: splitAddrs(bcc), subject, text, html
    });
    return info;
}

module.exports = { sendVerificationEmail, sendEmail };
