// services/qfFicha.js — gravação dos formulários que o FORNECEDOR preenche:
//   FORM 7.3.21 REV OUT26 — Cadastro e Avaliação (dados cadastrais, contatos, documentação
//                           com "Apresentado? SIM/NÃO/N/A" + arquivo, questionário de 36
//                           perguntas, assinatura eletrônica)
//   FORM 7.3.28           — Requalificação (confirma/atualiza cadastro, declara alterações
//                           do período, reenvia documentos vencidos/alterados)
// Usado pelo link público e pela transcrição interna (ficha recebida em papel/PDF).

const R = require('./qfRegras');
const Core = require('./qfCore');

const trim = (v) => (v == null ? '' : String(v).trim());
const corta = (v, n) => trim(v).slice(0, n) || null;

class ErroFicha extends Error { constructor(status, message, erros) { super(message); this.status = status; this.erros = erros; } }

// Campos da seção DADOS CADASTRAIS do FORM 7.3.21.
const CAMPOS_CADASTRO = [
  ['nome_fantasia', 120], ['razao_social', 200], ['cnpj', 20], ['inscricao_estadual', 30], ['inscricao_municipal', 30],
  ['endereco', 200], ['complemento', 80], ['cidade', 80], ['estado', 2], ['cep', 10], ['telefone', 40], ['website', 120],
  ['ramo_atividade', 120], ['tipo_empresa', 10], ['produto_servico', 400], ['lead_time', 120], ['condicoes_pagamento', 120]
];
const TIPOS_EMPRESA = ['S/A', 'LTDA', 'E.I.', 'EIRELI', 'OUTRO'];
const TIPOS_FRETE = ['CIF', 'VEICULO_PROPRIO', 'TRANSPORTADORA', 'FOB', 'EXW'];

// Alterações que o FORM 7.3.28 pede para declarar (PRO 5.10.1, "Análise das alterações").
// Declaração que o fornecedor aceita ao enviar (assinatura eletrônica). O texto é do SERVIDOR:
// a página mostra este texto e a ficha guarda o texto aceito + SHA-256 + data + IP (prova — RDC 665).
// Mudou o texto? Suba a versão.
const DECLARACAO = {
  versao: 'OUT26-1',
  texto: 'Declaro, em nome da empresa {empresa}, que as informações prestadas neste formulário e os documentos anexados são verdadeiros e refletem a situação atual da empresa; que comunicarei à GNATUS qualquer alteração que possa afetar os produtos ou serviços fornecidos; e que a GNATUS poderá verificar estas informações, inclusive por auditoria. Esta confirmação vale como minha assinatura eletrônica, registrada com data, hora e endereço IP.'
};
const textoDeclaracao = (empresa) => DECLARACAO.texto.replace('{empresa}', trim(empresa) || 'fornecedora');

const ALTERACOES_7328 = [
  { codigo: 'PROCESSO_PRODUTIVO', rotulo: 'Processo produtivo' },
  { codigo: 'LOCAL_FABRICACAO', rotulo: 'Local de fabricação' },
  { codigo: 'MATERIA_PRIMA', rotulo: 'Matéria-prima' },
  { codigo: 'RESPONSAVEL_TECNICO', rotulo: 'Responsável técnico' },
  { codigo: 'CERTIFICACOES', rotulo: 'Certificações' },
  { codigo: 'REGISTRO_ANVISA', rotulo: 'Registro ANVISA' },
  { codigo: 'OUTRAS', rotulo: 'Outras alterações que possam impactar o produto/serviço' }
];

function limparDados(b, formulario, docsPermitidos, anexosDaFicha) {
  const cad = {};
  for (const [k, n] of CAMPOS_CADASTRO) cad[k] = corta((b.cadastro || {})[k], n);
  if (cad.estado) cad.estado = cad.estado.toUpperCase();
  if (cad.tipo_empresa && !TIPOS_EMPRESA.includes(cad.tipo_empresa)) cad.tipo_empresa = 'OUTRO';
  cad.tipo_frete = (Array.isArray((b.cadastro || {}).tipo_frete) ? b.cadastro.tipo_frete : []).filter(t => TIPOS_FRETE.includes(t));
  const contatos = (Array.isArray(b.contatos) ? b.contatos : []).slice(0, 3)
    .map(c => ({ nome: corta(c.nome, 120), cargo: corta(c.cargo, 120), telefone: corta(c.telefone, 40), email: corta(c.email, 200) }))
    .filter(c => c.nome || c.email || c.telefone);
  const documentos = (Array.isArray(b.documentos) ? b.documentos : [])
    .filter(d => docsPermitidos.has(Number(d.tipoId)))
    .map(d => ({
      tipoId: Number(d.tipoId),
      apresentado: ['SIM', 'NAO', 'NA'].includes(d.apresentado) ? d.apresentado : null,
      comentario: corta(d.comentario, 1000),
      anexoId: d.anexoId && anexosDaFicha.has(Number(d.anexoId)) ? Number(d.anexoId) : null
    }));
  const dados = { cadastro: cad, contatos, documentos };
  if (formulario === '7.3.28') {
    dados.alteracoes = ALTERACOES_7328.map(a => {
      const x = (Array.isArray(b.alteracoes) ? b.alteracoes : []).find(y => y.codigo === a.codigo) || {};
      return { codigo: a.codigo, rotulo: a.rotulo, houve: x.houve === true, descricao: corta(x.descricao, 2000) };
    });
    dados.semAlteracoes = dados.alteracoes.every(a => !a.houve);
  }
  return dados;
}

async function gravarRespostas(Pg, ficha, fornecedor, body, { ip, exigirAceite = false } = {}) {
  if (!['RASCUNHO', 'ENVIADA', 'DEVOLVIDA', 'RESPONDIDA'].includes(ficha.status)) {
    throw new ErroFicha(409, 'Este formulário já foi analisado e não aceita novas respostas.');
  }
  if (exigirAceite && body.aceite !== true) throw new ErroFicha(400, 'Confirme a declaração de que as informações são verdadeiras (assinatura eletrônica).');
  const tipos = await Core.tiposDocumento(Pg);
  const docsPermitidos = new Set(R.documentosExigidos(tipos, fornecedor).map(x => Number(x.tipo.id)));
  const anexos = await Pg.connectAndQuery(`SELECT id FROM tab_qf_anexo WHERE entidade = 'ficha' AND entidade_id = @f AND NOT excluido`, { f: ficha.id });
  const dados = limparDados(body, ficha.formulario, docsPermitidos, new Set(anexos.map(a => Number(a.id))));
  if (body.aceite === true) {
    const texto = textoDeclaracao(dados.cadastro.razao_social || fornecedor.razao_social);
    dados.declaracao = { versao: DECLARACAO.versao, texto, sha256: require('crypto').createHash('sha256').update(texto).digest('hex'),
      aceitaEm: new Date().toISOString(), ip: ip || null, por: corta(body.respondente_nome, 120) };
  }
  const respondente = {
    nome: corta(body.respondente_nome, 120), cargo: corta(body.respondente_cargo, 120), email: corta(body.respondente_email, 200)
  };

  let placar = null, linhas = [];
  if (ficha.formulario === '7.3.21') {
    const perguntas = R.perguntasAplicaveis(await Pg.connectAndQuery(`SELECT * FROM tab_qf_pergunta WHERE ativo ORDER BY ordem, codigo`), fornecedor.criticidades);
    const respostas = (Array.isArray(body.respostas) ? body.respostas : []).map(r => ({
      perguntaId: Number(r.perguntaId), alternativa: trim(r.alternativa).toUpperCase() || null, comprovacao: trim(r.comprovacao)
    }));
    const erros = R.validarRespostas(perguntas, respostas);
    if (erros.length) throw new ErroFicha(400, erros[0], erros);
    const regra = await Core.regraAtiva(Pg);
    const pontos = regra.conteudo.pontos || { SIM: 2, PARCIAL: 1, NAO: 0 };
    placar = R.pontuarQuestionario(regra.conteudo, respostas.filter(r => r.alternativa), perguntas);
    const porId = new Map(respostas.filter(r => r.alternativa).map(r => [r.perguntaId, r]));
    // todas as perguntas aplicáveis ficam gravadas; em branco = NÃO (observação do FORM 7.3.21)
    linhas = perguntas.map(p => {
      const r = porId.get(Number(p.id));
      const alt = r ? r.alternativa : 'NAO';
      return { ficha_id: ficha.id, pergunta_id: p.id, pergunta_codigo: p.codigo, pergunta_secao: p.secao, pergunta_texto: p.texto,
        alternativa: alt, em_branco: !r, pontos: Number(pontos[alt]) || 0, comprovacao: r && r.comprovacao ? r.comprovacao.slice(0, 4000) : null };
    });
  }

  await Core.tx(Pg, async (q) => {
    if (ficha.formulario === '7.3.21') {
      await q(`DELETE FROM tab_qf_resposta WHERE ficha_id = @id`, { id: ficha.id });
      if (linhas.length) {
        await q(`INSERT INTO tab_qf_resposta (ficha_id, pergunta_id, pergunta_codigo, pergunta_secao, pergunta_texto, alternativa, em_branco, pontos, comprovacao)
                 SELECT ficha_id, pergunta_id, pergunta_codigo, pergunta_secao, pergunta_texto, alternativa, em_branco, pontos, comprovacao
                   FROM jsonb_to_recordset(@rows::jsonb) AS x(ficha_id int, pergunta_id int, pergunta_codigo text, pergunta_secao text,
                        pergunta_texto text, alternativa text, em_branco boolean, pontos numeric, comprovacao text)`, { rows: JSON.stringify(linhas) });
      }
    }
    await q(`UPDATE tab_qf_ficha SET status = 'RESPONDIDA', respondida_em = NOW(),
               respondente_nome = @nome, respondente_cargo = @cargo, respondente_email = @email, respondente_ip = @ip,
               aceite = @aceite, dados = @dados::jsonb,
               pontuacao_total = @tot, pontuacao_maxima = @max, pontuacao_percentual = @pct, por_secao = @sec::jsonb,
               devolvida_motivo = NULL, atualizado_em = NOW()
             WHERE id = @id`, {
      nome: respondente.nome, cargo: respondente.cargo, email: respondente.email, ip: ip || null, aceite: body.aceite === true,
      dados: JSON.stringify(dados),
      tot: placar ? placar.total : null, max: placar ? placar.maximo : null, pct: placar ? placar.percentual : null,
      sec: placar ? JSON.stringify(placar.porSecao) : null, id: ficha.id
    });
  });
  return { placar, respostas: linhas.length, emBranco: linhas.filter(l => l.em_branco).length, documentos: dados.documentos.length };
}

module.exports = { ErroFicha, gravarRespostas, CAMPOS_CADASTRO, TIPOS_EMPRESA, TIPOS_FRETE, ALTERACOES_7328, DECLARACAO, textoDeclaracao };
