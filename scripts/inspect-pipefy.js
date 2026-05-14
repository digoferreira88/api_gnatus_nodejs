// Inspecao do pipe Pipefy via GraphQL — mostra estrutura (fases, campos)
// + 3 cards recentes com valores e anexos.
//
// Uso:
//   PIPE_TOKEN=xxxx node scripts/inspect-pipefy.js [pipe_id]
//   ou
//   node scripts/inspect-pipefy.js [pipe_id] [token]
//
// Default pipe_id = 304059336 (Producao Gnatus).
//
// Requer Node 18+ (fetch nativo).

const PIPE_ID = String(process.argv[2] || '304059336');
const TOKEN   = process.argv[3] || process.env.PIPE_TOKEN;

if (!TOKEN) {
  console.error('Token nao informado. Use PIPE_TOKEN=xxx ou passe como 2o argv.');
  process.exit(1);
}

const URL = 'https://api.pipefy.com/graphql';

async function gql(query) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify({ query })
  });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch { console.error('Resposta nao JSON:', txt.slice(0, 500)); return {}; }
  if (j.errors) {
    console.error('GraphQL errors:', JSON.stringify(j.errors, null, 2));
  }
  return j.data || {};
}

(async () => {
  console.log(`\n========== Pipe ${PIPE_ID} ==========\n`);

  // 1) Metadata + phases + fields (inline pipe ID — variable ID! nao funciona)
  const meta = await gql(`
    {
      pipe(id: ${PIPE_ID}) {
        id
        name
        description
        phases {
          id
          name
          done
          fields {
            id
            label
            type
            required
            help
          }
        }
        start_form_fields {
          id
          label
          type
          required
        }
      }
    }`);

  if (!meta?.pipe) {
    console.error('Pipe nao encontrado ou sem permissao.');
    process.exit(1);
  }

  const p = meta.pipe;
  console.log(`Nome: ${p.name}`);
  console.log(`Descricao: ${(p.description || '').slice(0, 200)}\n`);

  console.log(`--- Start Form (campos no momento da criacao do card) ---`);
  (p.start_form_fields || []).forEach(f => {
    console.log(`  [${f.type}]${f.required ? '*' : ' '} ${f.label}  (id=${f.id})`);
  });

  console.log(`\n--- Fases (${p.phases.length}) ---`);
  p.phases.forEach((ph, idx) => {
    console.log(`\n  ${idx + 1}. "${ph.name}" ${ph.done ? '(DONE)' : ''}  (id=${ph.id})`);
    if (ph.fields.length) {
      ph.fields.forEach(f => {
        console.log(`     [${f.type}]${f.required ? '*' : ' '} ${f.label}  (id=${f.id})${f.help ? '  // ' + f.help.slice(0, 60) : ''}`);
      });
    } else {
      console.log(`     (sem campos)`);
    }
  });

  // 2) Cards recentes — pega 3 pra ver valores reais + anexos
  console.log(`\n========== Cards recentes (3) ==========\n`);
  const cards = await gql(`
    {
      cards(pipe_id: ${PIPE_ID}, first: 3) {
        edges {
          node {
            id
            title
            current_phase { id name }
            createdAt
            updated_at
            done
            fields {
              name
              value
              array_value
              field { id type label }
            }
            attachments {
              field { id label }
              url
            }
          }
        }
      }
    }`);

  const edges = cards?.cards?.edges || [];
  edges.forEach((e, i) => {
    const c = e.node;
    console.log(`--- Card ${i + 1}: "${c.title}" (id=${c.id}) ---`);
    console.log(`  Fase atual: ${c.current_phase?.name}`);
    console.log(`  Criado: ${c.createdAt} · Atualizado: ${c.updated_at}`);
    console.log(`  Done: ${c.done}`);
    console.log(`  Campos preenchidos:`);
    (c.fields || []).forEach(f => {
      const valor = f.value || (f.array_value && f.array_value.join(', ')) || '(vazio)';
      const v = String(valor).slice(0, 100);
      console.log(`    [${f.field?.type || '?'}] ${f.name}: ${v}${valor.length > 100 ? '...' : ''}`);
    });
    if (c.attachments && c.attachments.length) {
      console.log(`  Anexos (${c.attachments.length}):`);
      c.attachments.slice(0, 5).forEach(a => {
        console.log(`    - [${a.field?.label || '?'}] ${a.url.slice(0, 80)}...`);
      });
    }
    console.log('');
  });

  console.log(`========== FIM ==========\n`);
  process.exit(0);
})().catch(e => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
