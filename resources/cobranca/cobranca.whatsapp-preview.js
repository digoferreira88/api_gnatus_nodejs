// GET /cobranca/whatsapp-preview — lista candidatos do dia (D-1, D0, D+3)
// pra curadoria manual antes do envio. Marca quem ja foi enviado hoje.
// Permissao 1030.

// Acessivel pelo operador de Cobranca (9004) e por Tecnologia (1030 — pra debug).
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9004, 1030]);
const Scheduler = require('../../services/scheduler');

// Mesma tabela usada no painel (cobranca.painel.js). E1_FORMAPG nao tem cBox
// nem SX5 — mapeamento eh interpretacao comum no Protheus.
const FORMAS_PGTO = {
  '1': 'Cheque',
  '2': 'Dinheiro',
  '3': 'Cartão',
  '4': 'Boleto Bancário',
  '5': 'Não informado',
  '6': 'Financiamento',
  '7': 'Cartão BNDS',
  '8': 'Bonificação',
  '9': 'Consignado',
  'B': 'Antecipação Parcelada',
  'A': 'Futuro Garantido',
  '': 'Não informado'
};
const descreverFormaPgto = (cod) => FORMAS_PGTO[cod] || `Forma ${cod}`;

const chaveTitulo = (t) => [
  t.filial, t.prefixo, t.numero, t.parcela || '',
  t.cliente_cod, t.cliente_loja
].map(s => String(s || '').trim()).join('|');

module.exports = (app) => ({
  verb: 'get',
  route: '/whatsapp-preview',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus, Suri } = app.services;

    // Pra cada candidato a gente busca o ULTIMO envio OK do mesmo titulo+tipo
    // (sem janela de tempo) pra mostrar no UI "ultima cobranca em X". O operador
    // decide se reenvia. A unica trava automatica eh idempotencia por DIA
    // (UNIQUE INDEX no PG) — nao bloqueamos manualmente nada alem disso.

    try {
      // Busca paralela das 3 listas no Protheus
      const buscas = Scheduler.TIPOS.map(cfg =>
        Scheduler.buscarTitulos(Protheus, cfg.delta, cfg.mode)
          .then(rows => ({ tipo: cfg.tipo, rows }))
          .catch(err => ({ tipo: cfg.tipo, rows: [], erro: err.message }))
      );
      const resultados = await Promise.all(buscas);

      // Para cada chave|tipo, pega o envio mais recente (OK preferencialmente,
      // senao qualquer status). Inclui timestamp completo pra UI mostrar HH:MM.
      const historico = await Pg.connectAndQuery(`
        SELECT DISTINCT ON (filial, prefixo, numero, parcela, cliente_cod, cliente_loja, tipo)
               filial, prefixo, numero, parcela, cliente_cod, cliente_loja,
               tipo, status, disparo_em, criado_em, wamid
          FROM tab_cobranca_whatsapp_envio
         ORDER BY filial, prefixo, numero, parcela, cliente_cod, cliente_loja, tipo, criado_em DESC`,
        {}
      );
      const ultimoEnvio = new Map();
      historico.forEach(e => {
        ultimoEnvio.set(`${chaveTitulo(e)}|${e.tipo}`, {
          data: String(e.disparo_em).slice(0, 10),
          criado_em: e.criado_em,
          status: e.status
        });
      });

      const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
      const candidatos = { 'D-1': [], 'D0': [], 'D+3': [] };
      const totais = {};

      for (const { tipo, rows, erro } of resultados) {
        let comTel = 0, jaHojeCount = 0;
        const lista = rows.map(row => {
          const phone = Scheduler.extrairTelefone(row, Suri);
          const params = Scheduler.montarParametros(tipo, row);
          const env = ultimoEnvio.get(`${chaveTitulo(row)}|${tipo}`);

          let diasDesdeUltimoEnvio = null;
          if (env) {
            const [yy, mm, dd] = env.data.split('-').map(Number);
            const dEnv = new Date(yy, mm - 1, dd);
            diasDesdeUltimoEnvio = Math.round((hoje.getTime() - dEnv.getTime()) / 86400000);
          }
          // Idempotencia diaria: bloqueia so quem ja enviou HOJE.
          const jaHoje = env && diasDesdeUltimoEnvio === 0;

          if (phone) comTel++;
          if (jaHoje) jaHojeCount++;

          return {
            chave: chaveTitulo(row),
            filial: row.filial,
            prefixo: row.prefixo,
            numero: row.numero,
            parcela: row.parcela || '',
            cliente_cod: row.cliente_cod,
            cliente_loja: row.cliente_loja,
            cliente_nome: row.cliente_nome,
            valor: Number(row.saldo || 0),
            vencimento: row.vencimento,
            dias_atraso: Number(row.dias_atraso || 0),
            forma_pgto: String(row.forma_pgto || '').trim(),
            forma_pgto_nome: descreverFormaPgto(String(row.forma_pgto || '').trim()),
            telefone: phone,
            tem_telefone: !!phone,
            parametros: params,
            preview_mensagem: Suri.renderTemplate(tipo, params),
            ja_enviado_hoje: !!jaHoje,
            ultimo_envio_em: env?.criado_em || null,        // timestamp completo
            ultimo_envio_status: env?.status || null,
            dias_desde_ultimo_envio: diasDesdeUltimoEnvio
          };
        });
        candidatos[tipo] = lista;
        totais[tipo] = {
          encontrados: lista.length,
          com_telefone: comTel,
          ja_enviados: jaHojeCount,
          erro: erro || null
        };
      }

      // Lista de formas de pagamento presentes (pra popular o dropdown do filtro)
      const formasSet = new Map();
      for (const tipo of Object.keys(candidatos)) {
        for (const c of candidatos[tipo]) {
          if (c.forma_pgto !== undefined) {
            formasSet.set(c.forma_pgto, (formasSet.get(c.forma_pgto) || 0) + 1);
          }
        }
      }
      const formas_pgto_disponiveis = [...formasSet.entries()]
        .map(([cod, qtd]) => ({ cod, nome: descreverFormaPgto(cod), qtd }))
        .sort((a, b) => a.nome.localeCompare(b.nome));

      return res.json({
        data_referencia: new Date().toISOString().slice(0, 10),
        candidatos,
        totais,
        formas_pgto_disponiveis,
        gerado_em: new Date().toISOString()
      });
    } catch (err) {
      console.error('whatsapp-preview:', err);
      return res.status(500).json({ message: 'Erro ao montar preview: ' + err.message });
    }
  }
});
