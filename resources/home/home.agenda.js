// GET /home/agenda — compromissos de HOJE do PRÓPRIO usuário logado (M365/Graph).
//
// Alimenta o bloco "Hoje na sua agenda" do Meu Dia. Lê o calendário via Microsoft
// Graph (app-only, permissão Calendars.Read consentida no app "Intranet Gnatus -
// Reserva de salas"). ⚠️ O e-mail SEMPRE vem do req.user (nunca do cliente) — o
// usuário só enxerga a própria agenda. Assunto de compromisso privado/confidencial
// é mascarado. Sem requirePerm (home de todos; é o calendário do próprio usuário).

const trim = (v) => String(v == null ? '' : v).trim();

// cache do token do app (client credentials), com margem de 60s
let _tok = null, _exp = 0;
async function graphToken() {
  if (_tok && Date.now() < _exp - 60000) return _tok;
  const body = new URLSearchParams({
    client_id: process.env.M365_CLIENT_ID, client_secret: process.env.M365_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials'
  });
  const r = await fetch(`https://login.microsoftonline.com/${process.env.M365_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Graph token indisponível');
  _tok = j.access_token; _exp = Date.now() + (Number(j.expires_in || 3600) * 1000);
  return _tok;
}

module.exports = (app) => ({
  verb: 'get',
  route: '/agenda',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });
    if (!(process.env.M365_TENANT_ID && process.env.M365_CLIENT_ID && process.env.M365_CLIENT_SECRET)) {
      return res.json({ eventos: [], indisponivel: true });
    }

    try {
      // e-mail do PRÓPRIO usuário — do req.user ou do cadastro; jamais do cliente.
      let email = trim(user.EMAIL || user.email);
      if (!email) {
        const r = (await Pg.connectAndQuery(`SELECT email FROM tab_intranet_usr WHERE id = @id`, { id: user.ID }))[0];
        email = trim(r && r.email);
      }
      if (!email) return res.json({ email: null, eventos: [], aviso: 'Sem e-mail cadastrado.' });

      const d = new Date(), p = (n) => String(n).padStart(2, '0');
      const ymd = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/calendarView`
        + `?startDateTime=${ymd}T00:00:00&endDateTime=${ymd}T23:59:59`
        + `&$select=subject,start,end,location,isAllDay,onlineMeeting,showAs,sensitivity`
        + `&$orderby=start/dateTime&$top=25`;

      const tok = await graphToken();
      const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, Prefer: 'outlook.timezone="America/Sao_Paulo"' } });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        console.warn('home/agenda graph:', r.status, j.error && j.error.code);
        return res.json({ email, eventos: [], erro: true });
      }
      const j = await r.json();
      const eventos = (j.value || []).map(e => {
        const privado = e.sensitivity && e.sensitivity !== 'normal';
        return {
          inicio: (e.start && e.start.dateTime || '').slice(11, 16),
          fim: (e.end && e.end.dateTime || '').slice(11, 16),
          assunto: privado ? 'Compromisso' : (trim(e.subject) || '(sem título)'),
          local: privado ? '' : trim(e.location && e.location.displayName),
          teams: !!(e.onlineMeeting),
          diaTodo: !!e.isAllDay,
          livre: e.showAs === 'free'
        };
      });
      return res.json({ email, ymd, eventos, geradoEm: new Date().toISOString() });
    } catch (err) {
      console.error('home/agenda:', err);
      return res.status(500).json({ message: 'Erro ao carregar agenda.' });
    }
  }
});
