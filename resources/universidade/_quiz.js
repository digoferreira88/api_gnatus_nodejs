// Avaliação com banco de questões (migration 151).
// O quiz tem N questões (o "banco"); a cada tentativa sorteia qtd_sorteio delas (NULL = todas),
// embaralha a ordem (sempre que há sorteio, ou se `embaralhar`) e, se `embaralhar_alternativas`,
// a ordem das alternativas. O sorteio fica em tab_uni_tentativa.questoes:
//   [{ "q": questao_id, "a": [alternativa_id, ...] }, ...]
// Correção e revisão usam só o que foi sorteado. Tentativa antiga (questoes NULL) = todas.

const embaralhar = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Banco completo do quiz (questões + alternativas, com a flag correta).
async function banco(Pg, quizId) {
  const questoes = await Pg.connectAndQuery(`
    SELECT id, ordem, enunciado, tipo, pontuacao FROM tab_uni_questao WHERE quiz_id = @qid ORDER BY ordem, id`, { qid: quizId });
  const alts = questoes.length ? await Pg.connectAndQuery(`
    SELECT id, questao_id, ordem, texto, correta FROM tab_uni_alternativa
     WHERE questao_id = ANY(@ids::int[]) ORDER BY questao_id, ordem, id`, { ids: questoes.map(q => q.id) }) : [];
  const porQ = new Map();
  alts.forEach(a => { if (!porQ.has(a.questao_id)) porQ.set(a.questao_id, []); porQ.get(a.questao_id).push(a); });
  return questoes.map(q => ({
    id: q.id, ordem: q.ordem, enunciado: q.enunciado, tipo: q.tipo, pontuacao: Number(q.pontuacao),
    alternativas: (porQ.get(q.id) || []).map(a => ({ id: a.id, ordem: a.ordem, texto: a.texto, correta: a.correta }))
  }));
}

// Sorteia as questões de uma nova tentativa.
function sortear(quiz, questoes) {
  const qtd = Number(quiz.qtd_sorteio) || 0;
  const sorteia = qtd > 0 && qtd < questoes.length;
  let lista = sorteia || quiz.embaralhar ? embaralhar(questoes) : [...questoes];
  if (sorteia) lista = lista.slice(0, qtd);
  return lista.map(q => ({
    q: q.id,
    a: (quiz.embaralhar_alternativas && q.tipo !== 'verdadeiro_falso' ? embaralhar(q.alternativas) : q.alternativas).map(a => a.id)
  }));
}

// Questões de uma tentativa, na ordem em que o aluno viu. comCorreta=false esconde o gabarito.
function montar(questoesBanco, sorteio, comCorreta) {
  const porId = new Map(questoesBanco.map(q => [q.id, q]));
  const base = Array.isArray(sorteio) && sorteio.length
    ? sorteio.map(s => {
        const q = porId.get(Number(s.q));
        if (!q) return null;
        const altPor = new Map(q.alternativas.map(a => [a.id, a]));
        const ordem = (s.a || []).map(id => altPor.get(Number(id))).filter(Boolean);
        q.alternativas.forEach(a => { if (!ordem.includes(a)) ordem.push(a); }); // alternativa criada depois
        return { ...q, alternativas: ordem };
      }).filter(Boolean)
    : questoesBanco;
  return base.map(q => ({
    ...q,
    alternativas: q.alternativas.map(a => comCorreta ? a : { id: a.id, ordem: a.ordem, texto: a.texto })
  }));
}

module.exports = { banco, sortear, montar };
