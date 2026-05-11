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
        to, cc, bcc, subject, text, html
    });
    return info;
}

module.exports = { sendVerificationEmail, sendEmail };
