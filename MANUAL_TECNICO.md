# Manual Técnico — Intranet GNATUS 2026

Documento de referência técnico do projeto. Para cada módulo, descreve **o que faz**, **como funciona**, **quais tabelas/serviços usa** e **regras de negócio importantes**.

> Este manual é mantido junto ao código (vive no repo do backend). Atualizar quando mexer em qualquer módulo.

---

## 1. Visão geral

A Intranet GNATUS substitui processos manuais (planilhas, sistemas legados, formulários) por uma aplicação web única, integrada ao ERP **Protheus** (TOTVS) e ao **Microsoft 365**.

**Dois repositórios** (github.com/digoferreira88, branch `master`):
- **Backend**: `api_gnatus_nodejs` — Node.js 22 + Express, porta 3000
- **Frontend**: `frontend_intranet_react` — Vite + React 18 + TypeScript, porta 5173 (dev)

> Os repos viviam em `github.com/gnatusintranet` até 2026-05; foram migrados pra conta pessoal `digoferreira88`. Os redirects do GitHub continuam funcionando, mas o `git remote -v` correto aponta pra `digoferreira88/...` em ambos os clones (PC e VPS).

**Produção**: `https://intranew.gnatus.com.br` (VPS Hostinger Boston, IP `177.7.37.251`).

**Bancos**:
- **PostgreSQL 16** (`intranet`) — todos os dados próprios da intranet (usuários, perms, cofre, cobrança, equipamentos, atribuições)
- **MSSQL Protheus** (read-only) — leitura do ERP via VPN/NAT (SE1, SA1, SC5, SF2, SD1, SX5, SB1/SB2, SG1, etc.)
- **MySQL** — apenas autenticação de tipos legados (`motorista`, `eco_camarote`)

---

## 2. Arquitetura

### 2.1 Backend

**Entry point**: [`index.js`](index.js) carrega `dotenv` → cria express → injeta `cors` + `body-parser` → carrega services via `config/loader.js` → registra rotas via `config/resources.js` → sobe socket.io.

**Auto-discovery de rotas** ([`config/resources.js`](config/resources.js)): varre `resources/**/*.js`. Cada arquivo exporta:
```js
module.exports = (app) => ({
  verb: 'get',         // método HTTP
  route: '/foo',       // path relativo
  handler: async (req, res) => { ... },
  anonymous: false,    // se true, pula middleware de auth
  middlewares: [...]   // opcionais
});
```
A pasta vira prefixo: `resources/cobranca/cobranca.dashboard.js` com `route: '/dashboard'` → `GET /cobranca/dashboard`.

**Autenticação** ([`middlewares/authentication.js`](middlewares/authentication.js)): valida Bearer JWT, popula `req.user` consultando o banco apropriado conforme `decoded.type`:
- `usuario` (default) → `tab_intranet_usr` (Postgres)
- `motorista`, `eco_camarote` → MySQL legado
- `franqueado` → tabela específica (não usada na intranet web atual)

**Padrão de query**: SQL parametrizado via [`services/pg.js`](services/pg.js) com tradução de sintaxe MSSQL→PG (`@param` → `$N`, `GETDATE()` → `NOW()`). Retornos sempre RTRIM em strings do Protheus.

### 2.2 Frontend

- **Roteamento**: [`src/Routes.tsx`](../frontend_intranet_react/src/Routes.tsx) com `react-router-dom v6`. Cada rota envolve `<Protect requiredPerms={[code, 0]}>...`
- **Proteção** ([`src/services/Protect.tsx`](../frontend_intranet_react/src/services/Protect.tsx)): valida JWT, busca perms via `/users/me`, redireciona pra `/login` ou `/` conforme acesso
- **Sidebar dinâmica** ([`src/utils/GetSidebar.tsx`](../frontend_intranet_react/src/utils/GetSidebar.tsx)): filtra itens por perm do user
- **Cliente HTTP**: [`src/services/Api.tsx`](../frontend_intranet_react/src/services/Api.tsx) (axios + Bearer JWT)
- **MSAL** ([`src/utils/msalConfig.ts`](../frontend_intranet_react/src/utils/msalConfig.ts)): Azure AD pra Reserva de Sala (Microsoft Graph)

### 2.3 Padrão de permissões

Cada item de menu / rota tem array `perm: [N, 0]`:
- **`[]`** → qualquer usuário logado vê (Dashboard, Alterar Senha)
- **`[0]`** → admin universal
- **`[N, 0]`** → quem tem perm N OU quem é admin
- Lógica em [`Protect.tsx`](../frontend_intranet_react/src/services/Protect.tsx) e [`GetSidebar.tsx`](../frontend_intranet_react/src/utils/GetSidebar.tsx)

⚠️ **Bug histórico** (já corrigido): código antigo usava `requiredPerms.includes(0)` o que liberava qualquer rota com `0` na lista pra todos. Hoje usa `userPerms.includes(0)` (admin é o usuário, não a rota).

---

## 3. Módulos do sistema

### 3.1 Tecnologia

#### Gestão de Usuários · `/tecnologia/usuarios` · perm 1028
- **Página**: [GestaoUsuarios.tsx](../frontend_intranet_react/src/pages/GestaoUsuarios/GestaoUsuarios.tsx)
- **Endpoints**: `/users/all`, `/users/create` (aceita `permissoes[]` no body), `/users/:id/update`, `/users/:id/toggle-active`
- **Modal de criação**: tabs **Dados** + **Permissões**. Permissões selecionadas vão junto no payload (batch insert em `tab_intranet_usr_permissoes` com `ON CONFLICT DO NOTHING`).
- **Modal de edição**: toggle individual por perm (chamada otimista que reverte em erro)
- Inclui campos `codigoProtheus` (USR_ID em SYS_USR — necessário pra aprovações SC/PC) e `ramal` (PABX click-to-call)
- Mostra usuários inativos (filtro removido em `users.all.js` pra permitir reativar)

#### Gerenciamento de Permissões · `/permissoes` · perm 1026
- **Página**: [Permissoes.tsx](../frontend_intranet_react/src/pages/Permissoes/Permissoes.tsx)
- CRUD do catálogo (`tab_intranet_permissoes`) e atribuição em massa
- Aceita `id_permissao = 0` (admin universal) — corrigido em backend (validação antiga rejeitava com `!idPerm`)

#### Termo de Responsabilidade · `/tecnologia/termo-equipamento` · perm 1027
- **Página**: [TermoEquipamento.tsx](../frontend_intranet_react/src/pages/TermoEquipamento/TermoEquipamento.tsx)
- Formulário CLT/PJ → preview do termo → `window.print()` (CSS `@media print`)
- Salva log em `tab_termo_equipamento` E **automaticamente** registra equipamento ATIVO em `tab_equipamento_atual` (idempotente via `id_termo_origem`)
- CSS print força `visibility/opacity/color` em `.termo__doc *` pra evitar branco-em-branco

#### Equipamentos com Colaboradores · `/tecnologia/equipamentos` · perm 1027
- **Página**: [Equipamentos.tsx](../frontend_intranet_react/src/pages/Equipamentos/Equipamentos.tsx)
- Visão consolidada de quem tem o quê. KPIs: colaboradores, ativos, defeitos, devoluções
- **Tabela `tab_equipamento_atual`** ([migration 12](database/postgres/12-tecnologia-equipamento-atual.sql)):
  - status: `ATIVO` | `SUBSTITUIDO` | `REMOVIDO`
  - motivo: `DEFEITO` | `PERDA` | `FIM_CONTRATO` | `UPGRADE` | `OUTRO`
  - `id_substituicao` aponta pro novo registro quando há troca
  - calcula `diasDeUso = data_remocao - data_entrega` (ou `today - data_entrega` se ATIVO)
- Drawer ao clicar no colaborador: equipamentos ativos + histórico (com tempo de uso)
- Ações por equipamento: **Adicionar** / **Substituir** (registra motivo + cria novo) / **Remover** (com motivo)
- Checkbox "Gerar termo após salvar" → redireciona pra `/tecnologia/termo-equipamento` com query params pré-preenchidos

#### Provisionamento (AD + M365) · `/tecnologia/provisionamento` · perm 1029
- **Página**: [Provisionamento.tsx](../frontend_intranet_react/src/pages/Provisionamento/Provisionamento.tsx)
- Cria usuário no AD local (`gnt.local`) + M365 (Graph API) numa só ação
- **Backend service**: [services/ad.js](services/ad.js) (`ldapts`) + [services/m365.js](services/m365.js) (Graph SDK)
- Endpoints em `/provisionamento`: `ous`, `grupos`, `licencas-m365`, `criar`, `desligar`, `buscar-usuarios`
- Requer `.env`: `AD_URL`, `AD_BASE_DN`, `AD_BIND_USER`, `AD_BIND_PASSWORD`, `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_SECRET`
- Em produção, AD é acessado via **VIP do FortiGate** (200.15.18.119:36363 → 172.31.255.100:636 LDAPS)

#### Cobrança WhatsApp (relatório/automação) · `/tecnologia/cobranca-whatsapp` · perm 1030
- **Página**: [CobrancaWhatsApp.tsx](../frontend_intranet_react/src/pages/CobrancaWhatsApp/CobrancaWhatsApp.tsx)
- **Service**: [services/scheduler.js](services/scheduler.js) (cron `09:00` todo dia) + [services/suri.js](services/suri.js) (cliente HTTP do Fluig SURI)
- Dispara mensagem WhatsApp pra clientes com títulos em **D-1** (lembrete), **D0** (vencimento) e **D+3** (atraso)
- Idempotente via UNIQUE em `tab_cobranca_whatsapp_envio (disparo_em, tipo, chave_titulo)` — não envia mesmo título 2x no dia
- Templates parametrizados (Gupshup/Meta): nome do cliente, nº NF, valor, vencimento
- Página exibe relatório dos envios (OK/ERRO/SEM TELEFONE) + botão "Disparar agora" + toggle de ligar/desligar automação
- Toggle persistido em `tab_cobranca_whatsapp_config.chave = 'automacao_ativa'`
- O **operador de cobrança** usa o módulo paralelo em `/cobranca/envio-whatsapp` (perm 9004) — preview com curadoria manual antes do envio
- Endpoint do SURI descoberto via SSH no Fluig PHP da Develsoft: `POST /api/messages/send` (Basic Auth)

#### Importação Protheus (TRPWSIMP) · `/tecnologia/importar-protheus` · perm 1031
- **Página**: [ProtheusImport.tsx](../frontend_intranet_react/src/pages/ProtheusImport/ProtheusImport.tsx)
- **Service**: [services/trpwsimp.js](services/trpwsimp.js) — cliente do **Template MIT072** da TOTVS (REST nativo do Protheus)
- Permite **importação em massa** de dados pra qualquer tabela cadastrada no MIT072 (47+ IDs catalogados: SA1 clientes, SA2 fornecedores, SB1 produtos, SC5 pedidos, SF6 movimentos, etc)
- Lê **SX3** (dicionário Protheus) pra trazer descrição dos campos com `X3_OBRIGAT` (na Gnatus = 'x' minúsculo, não 'S' do padrão TOTVS)
- **Layouts salvos** ([migration 28](database/postgres/28-protheus-import-layout.sql)): operador salva mapeamento coluna XLSX → campo Protheus pra reuso
- **Log de execuções** em `tab_protheus_import_log` (sucesso/erro, qt registros, JSON do request/response)
- Auditoria: cada execução com severidade CRITICO

#### Linhas Móveis (Claro/TIM) · `/tecnologia/telefonia-movel` · perm 1027
- **Página**: [TelefoniaMovel.tsx](../frontend_intranet_react/src/pages/TelefoniaMovel/TelefoniaMovel.tsx)
- **Service de import**: [services/telefoniaImport.js](services/telefoniaImport.js) — parser do XLSX legado "Gnatus_Linhas_Telefonia Móvel"
- Substitui a planilha. Detecta múltiplos blocos `NºConta: ... | NºCliente: ...` por aba (Claro/TIM/Vivo) e converte em registros
- **Tabelas** ([migration 31](database/postgres/31-telefonia-movel.sql)):
  - `tab_operadora` (Claro, TIM, Vivo — seed)
  - `tab_telefonia_conta` (1 conta por operadora — pode ter várias por operadora)
  - `tab_telefonia_departamento` (alimentada da planilha)
  - `tab_telefonia_linha` (1 linha = 1 número de telefone)
  - `tab_telefonia_linha_hist` (histórico de troca de titular/status/plano)
- UNIQUE em `(id_operadora, numero_telefone)` garante idempotência da importação
- CRUD completo + filtros (operadora/status/depto/busca/vencimento) + KPIs (total/ativas/suspensas/canceladas/estoque/vencendo)
- Drawer com histórico completo de mudanças
- **Custo mensal** ([migration 37](database/postgres/37-telefonia-valor.sql)): coluna `valor_mensal numeric(10,2)` em `tab_telefonia_linha`. KPI verde "Custo mensal (ativas)" + coluna "Valor/mês" na tabela + totalizador do filtro atual no header. Soma agrupada por operadora aparece na linha de resumo

#### Auditoria (logs centralizados) · `/tecnologia/auditoria` · perm 1032
- **Página**: [Auditoria.tsx](../frontend_intranet_react/src/pages/Auditoria/Auditoria.tsx)
- **Service**: [services/auditoria.js](services/auditoria.js) — função `registrar(app, opts)` não-bloqueante (catch silencioso)
- **Tabela** `tab_auditoria` ([migration 29](database/postgres/29-tecnologia-auditoria.sql)): modulo, submodulo, acao, severidade (`INFO`/`AVISO`/`ALERTA`/`CRITICO`), usuario, entidade, descrição, antes/depois (jsonb), meta (jsonb), ip, user_agent
- Índice GIN trigram (pg_trgm) em `descricao` pra busca textual rápida
- Filtros: módulo, severidade, usuário, data, busca livre
- KPIs do dia: total, eventos críticos, alertas, usuários distintos
- Drill-down em cada log: vê antes/depois em JSON formatado
- **Sem expiração** — logs ficam indefinidamente (compliance LGPD)
- **Onda 1 instrumentada**: Cofre, Aprovações Compras, Provisionamento, Importação Protheus, Telefonia, Contratos, Apoio Gerencial, Envio Boleto, Auditoria Própria

---

### 3.2 Faturamento

#### Ranking de Vendedores (Faturamento NF) · `/vendas/ranking` · perm 2001
- **Página**: [VendasRanking.tsx](../frontend_intranet_react/src/pages/VendasRanking/VendasRanking.tsx) (modo padrão = `faturamento`)
- **Endpoint**: [GET /vendas/ranking-faturamento](resources/vendas/vendas.ranking-faturamento.js)
- Pódio top 3 (medalhas) + lista. Avatares em `public/avatars/vendedores/{cod}.png` com fallback.
- **Filtro por BU** (dropdown populado com `SC5.C5_ZTIPO` → `SX5.X5_DESCRI` X5_TABELA='Z1' do período). O dropdown lista TODAS as BUs do período mesmo com filtro ativo (response devolve `bus[]` à parte do `ranking` filtrado)
- **Input de Cód. Vendedor** alternativo ao dropdown (compartilha mesmo state — digitar é mais rápido que rolar lista)
- **Export XLSX** (3 abas: Resumo / Ranking / Por BU) — mesma pegada visual dos outros dashboards

#### Ranking de Vendas (Pedidos em aberto) · `/vendas/ranking-vendas` · perm 2005
- **Página**: [VendasRanking.tsx](../frontend_intranet_react/src/pages/VendasRanking/VendasRanking.tsx) com prop `modo="vendas"` ([migration 41](database/postgres/41-vendas-ranking-perm.sql) cria perm 2005)
- **Endpoint**: [GET /vendas/ranking-vendas](resources/vendas/vendas.ranking-vendas.js)
- Distinto do Ranking de Faturamento: usa SC5/SC6 (pedidos em aberto, ainda NÃO faturados — `C6_BLQ <> 'R'`, `C6_QTDVEN > C6_QTDENT`)
- Mesma UI (pódio + filtros) mas KPI são pedidos colocados, não NFs

#### Relatório de Faturamento · `/vendas/faturamento` · perm 2002
- **Página**: [FaturamentoRelatorio.tsx](../frontend_intranet_react/src/pages/FaturamentoRelatorio/FaturamentoRelatorio.tsx)
- 73 colunas via `exceljs`. Preview paginado + export `.xlsx`.
- **Filtros adicionados (2026-05)**: BU (dropdown populado pelo response, ordenado por faturamento) + Cód. Vendedor (input alternativo ao dropdown). Backend aceita `?bu=` e `?vendedor=` (filtra `SC5.C5_ZTIPO` e `SC5.C5_VEND1/2/3`)

#### Vendas Analítico (5 sub-páginas) · perms 2003/2004
> Migrado do legado PHP. Cada análise vira página própria sob `/vendas/...`. Compartilham helper `_cfops.js` (CFOPs de venda hardcoded).

##### Curva ABC · `/vendas/curva-abc` · perm 2004/2002
- **Página**: [CurvaABC.tsx](../frontend_intranet_react/src/pages/VendasAnalitico/CurvaABC.tsx)
- **Endpoint**: [GET /vendas/curva-abc](resources/vendas/vendas.curva-abc.js)
- Curva ABC por **produto**: SD2 + SB1 no período filtrado por CFOP de venda, subtrai devoluções proporcionais
- Categoria A: ≤80% acumulado · B: 80-95% · C: 95-100%
- Ordenação DESC por valor total. Tabela + chart de Pareto

##### Carteira de Pedidos · `/vendas/carteira` · perm 2004/2002
- **Página**: [Carteira.tsx](../frontend_intranet_react/src/pages/VendasAnalitico/Carteira.tsx)
- **Endpoint**: [GET /vendas/carteira](resources/vendas/vendas.carteira.js)
- Pipeline de pedidos abertos por BU (`C5_ZTIPO`). Saldo = `(C6_QTDVEN - C6_QTDENT) × preço unitário com IPI`
- Buckets de entrega (`C6_ENTREG`): **atrasada** (< 1º dia mês) · **mês_atual** · **mês_p1** · **mês_p2** · **futuro** (≥ mês+3)
- Filtros: vendedor

##### Itens sem Movimento · `/vendas/itens-sem-movimento` · perm 2004/2002
- **Página**: [ItensSemMovimento.tsx](../frontend_intranet_react/src/pages/VendasAnalitico/ItensSemMovimento.tsx)
- **Endpoint**: [GET /vendas/itens-sem-movimento](resources/vendas/vendas.itens-sem-movimento.js)
- Usa **views customizadas no Protheus** (legado): `itens_diassemvenda` (D2_COD, dias desde última saída) + `itens_saldoarmazem` (B2_COD, saldo disponível, B2_CM1) + `nnr010` (descrição armazém)
- Filtros: `dias` (default 180), `armazem`
- Calcula valor parado = qtd × custo médio

##### Histórico Anual · `/vendas/historico-anual` · perm 2004/2002
- **Página**: [HistoricoAnual.tsx](../frontend_intranet_react/src/pages/VendasAnalitico/HistoricoAnual.tsx)
- **Endpoint**: [GET /vendas/historico-anual](resources/vendas/vendas.historico-anual.js)
- Comparativo ano a ano de faturamento por mês (12 meses × N anos)
- Drill por vendedor/equipe/BU/cliente/produto

##### Saídas Diversas · `/planejamento/saidas-diversas` · perm 2003/2002
- **Página**: [SaidasDiversas.tsx](../frontend_intranet_react/src/pages/SaidasDiversas/SaidasDiversas.tsx)
- **Endpoint**: [GET /vendas/saidas-diversas](resources/vendas/vendas.saidas-diversas.js)
- Cruza TES de "acompanhar" (538/546/540/559) e "diversos" (539/543/585/566/595/606/607) — lista vem de `tab_vendas_tes_categoria` (migration 21)
- 3 seções: **acompanhamento** (TES acompanhar, valor mês + acumulado de TODO histórico) · **diversosMes** (TES diversos no período) · **diversosAcumulado** (mesmas TES sem filtro de início, ≤ fim)

---

### 3.3 Compras

#### Solicitações de Compra · `/compras/solicitacoes` · perm 4001
- **Página**: [SolicitacoesCompra.tsx](../frontend_intranet_react/src/pages/Compras/SolicitacoesCompra.tsx)
- SC1010 do Protheus, decoders de status, auto-refresh 30s

#### Nova Solicitação de Compra · `/compras/nova-sc` · perm 4004
- **Página**: [NovaSolicitacaoCompra.tsx](../frontend_intranet_react/src/pages/Compras/NovaSolicitacaoCompra.tsx)
- **Endpoint**: [POST /compras/sc-criar](resources/compras/compras.sc-criar.js)
- **Service**: [services/protheusSolicCompra.js](services/protheusSolicCompra.js) — wrapper de `POST {PROTHEUS_API_URL}/SolicCompra/incluir` (REST custom Develsoft, formato MIT072)
- Permite abrir SC pela Intranet sem precisar logar no Protheus. Após criada, **aparece em "Minhas Aprovações"** pra quem tem alçada (fluxo SCR/SAL idêntico ao processo do ERP)
- **Body**: `{ data_necessaria (YYYY-MM-DD), observacao?, itens: [{produto, quantidade, local?, centro_custo, observacao?, fornecedor?, loja?}], anexos?: [{nome, descricao?, base64, item?}] }`
- Limites: max 50 itens · max 10 anexos · 10MB total de anexos (base64 expandido ~13MB) · timeout 180s
- **Solicitante**: deriva de `CODIGO_PROTHEUS` (USR_ID) → SYS_USR.USR_CODIGO (login Protheus, 6 chars). Email/nome direto estouravam C1_USER e crashavam o AdvPL com 500 genérico
- **Anexos opcionais**: gravados em AC9010/ACB010 ("Conhecimento" do Protheus). Item omitido = anexo do cabeçalho; com `item: N` = anexo do item N
- **Endpoints auxiliares**:
  - [GET /compras/produto-buscar?q=...](resources/compras/compras.produto-buscar.js) — busca SB1 por código/descrição (autocomplete)
  - [GET /compras/centros-custo](resources/compras/compras.centros-custo.js) — lista CTT010 (centros de custo válidos)
- **Log**: cada tentativa em `tab_sc_intranet_log` ([migration 43](database/postgres/43-compras-solicitar.sql)) com payload, response, http_status, sc_numero, status (SUCESSO/REJEITADA/ERRO_SISTEMA), mensagem_erro, duração ms
- Auditoria CRITICO em SUCESSO, ALERTA em REJEITADA. ⚠️ A SC vive no Protheus (SC1010) — esta tabela é só histórico/auditoria, não fonte de verdade

#### Pedidos de Compra · `/compras/pedidos` · perm 4002
- **Página**: [PedidosCompra.tsx](../frontend_intranet_react/src/pages/Compras/PedidosCompra.tsx)
- SC7010, chips filtráveis, drawer com itens

#### Minhas Aprovações · `/compras/aprovacoes` · perm 13001
- **Página**: [Aprovacoes.tsx](../frontend_intranet_react/src/pages/Compras/Aprovacoes.tsx)
- Pega documentos pendentes pra aprovador logado consultando SCR010 (fila de aprovação Protheus) cruzado com SAL010 (cadastro de aprovadores por grupo)
- Aprova/rejeita via API REST custom Gnatus do Protheus (`POST http://protheus.gnatus.com.br:8081/rest/AprovaCompras/aprovar` — Basic Auth, **não** TOTVS REST padrão)
- Pedido também traz observações (C7_OBS/OBSM/OBSFOR) e anexos via TOTVS Documents (base64 `EncodeDocument`)
- Auditoria registra cada APPROVE/REJECT com severidade CRITICO (módulo `Compras/Aprovacoes`)
- ⚠️ Variáveis na rotina de auditoria: usar `tipoIntranet` e `justificativa` (não `tipo`/`observacao` — bug corrigido em 2026-05)
- **Fix de alçada (2026-05-13)**: query do `pendentes.js` listava SCs pra qualquer membro do grupo SAL, mesmo quando a SCR tinha aprovador NOMEADO em `CR_USER`. O Protheus rejeitava com 403 ("não faz parte da alçada"). Caso real: SC 175950 tinha `CR_USER='000256','000070'` mas a Intranet listava pra Demer (membro do grupo PCP). Regra atualizada: **só usar alçada por grupo se `CR_USER` estiver vazio**. Script de diagnóstico em [scripts/debug-sc-alcada.js](scripts/debug-sc-alcada.js) (`node scripts/debug-sc-alcada.js <numero> <usr_codigo>`)

#### MCL — Compras Mínimas Lucrativas · `/compras/mcl` · perm 4003
- **Páginas**: [MCL.tsx](../frontend_intranet_react/src/pages/MCL/MCL.tsx) (dashboard) + [Apresentacao.tsx](../frontend_intranet_react/src/pages/MCL/Apresentacao.tsx) (slideshow pra diretoria)
- **Tabelas** ([migrations 13-15](database/postgres/13-compras-mcl.sql)):
  - `tab_mcl_indice` (índice padrão de margem por categoria/grupo)
  - `tab_mcl_sc_snapshot` (snapshot de SC pra acompanhamento histórico)
  - `tab_mcl_scii` (SC Item Imobilizado — comparação preço/orçamento)
  - `tab_mcl_standard_cost` (custo padrão pra calcular Δ)
- Compara solicitações de compra em curso vs custo padrão e flags itens fora do range
- Endpoints: `mcl-dashboard`, `mcl-sc-list`, `mcl-sc-snapshot`, `mcl-sc-comparacao`, `mcl-scii`, `mcl-scii-sync`, `mcl-pva`, `mcl-config`, `mcl-indice-upsert`, `mcl-sync`

---

### 3.4 SAC

#### Consulta de Cliente · `/sac/cliente` · perm 6001
- **Página**: [SAC.tsx](../frontend_intranet_react/src/pages/SAC/SAC.tsx)
- Busca por nome/código → 360° (cadastro + histórico de NF + drawer de NF)
- Click-to-call via PABX FALEmais (precisa `ramal` do user)

#### Supervisão SAC · `/sac/supervisao` · perm 6002
- **Página**: [SupervisaoSAC.tsx](../frontend_intranet_react/src/pages/SAC/SupervisaoSAC.tsx)
- Lista chamadas de todos os ramais + player de áudio das gravações
- Backend [services/falemais.js](services/falemais.js) usa Sigma API + Gravacoes API

---

### 3.5 Financeiro

#### Contas a Pagar · `/financeiro/contas-pagar` · perm 8001
- **Página**: [ContasPagar.tsx](../frontend_intranet_react/src/pages/Financeiro/ContasPagar.tsx)
- SE2010 do Protheus, filtros por base (emissão/vencimento) + fornecedor + status

#### Contas a Receber · `/financeiro/contas-receber` · perm 8002
- **Página**: [ContasReceber.tsx](../frontend_intranet_react/src/pages/Financeiro/ContasReceber.tsx)
- SE1010 análogo, com cálculo de multa/juros

#### Fluxo de Caixa · `/financeiro/fluxo-caixa` · perm 8004
- **Página**: [FluxoCaixa.tsx](../frontend_intranet_react/src/pages/Financeiro/FluxoCaixa.tsx)
- **Endpoint**: [GET /financeiro/fluxo-caixa](resources/financeiro/financeiro.fluxo-caixa.js)
- Combina SE1 (a receber) + SE2 (a pagar) projetando saldo dia a dia
- Filtros: cliente, equipe, BU, forma de pagamento

#### Envio de Boleto (curadoria + bordero + retorno banco) · `/financeiro/envio-boleto` · perm 8005
- **Página**: [EnvioBoleto.tsx](../frontend_intranet_react/src/pages/Financeiro/EnvioBoleto.tsx)
- **Tabelas**:
  - [migration 35](database/postgres/35-financeiro-envio-boleto.sql) — `tab_boleto_envio_lote` (cabeçalho) + `tab_boleto_envio_lote_titulo` (itens)
  - [migration 42](database/postgres/42-boleto-bordero-protheus.sql) — adiciona em `tab_boleto_envio_lote`: `lote_protheus`, `enviado_em`, `enviado_por_email`, `qt_processados`, `qt_rejeitados`, `protheus_resposta jsonb`
  - [migration 44](database/postgres/44-boleto-retorno.sql) — `tab_boleto_envio_lote_retorno` (1 row por título com status do banco) + colunas de contadores no lote (`sincronizado_em`, `qt_registrados`, `qt_liquidados`, `qt_rejeitados_banco`, `qt_pendentes_banco`)
- **Endpoints** em `resources/financeiro/financeiro.boleto-*.js`: bancos · elegíveis · lote-create · lote-list · lote-detail · **lote-enviar-protheus** · **lote-sincronizar**
- **Bancos comerciais** (filtro hardcoded): `001` BB · `033` Santander · `104` CEF · `237` Bradesco · `341` Itaú · `422` Safra · `748` Sicredi · `756` Sicoob — exclui FIDCs/cartões/aplicações dos 156 cadastros do SA6010
- **Formas de pagamento elegíveis** (default): `4` Boleto · `A` Futuro Garantido · `B` Antecipação Parcelada
- **Regra do filtro de portador (importante)**: lista APENAS títulos com `E1_PORTADO` JÁ preenchido (banco já decidido pelo financeiro). Antes mostrava títulos sem portador, contradizendo o fluxo real. Resultado: ~285 títulos / R$ 1,77M elegíveis hoje.
- Operador **seleciona títulos** com checkbox + footer sticky com **valor total selecionado** (KPI grande verde)
- "Banco do lote" derivado dos títulos selecionados (se 2+ bancos sem filtrar, bloqueia com aviso vermelho)

##### Fluxo de status do lote
| Status | Quem dispara | O que aconteceu |
|---|---|---|
| `CRIADO` | Operador (POST lote-create) | Lote registrado na Intranet, ainda não enviado |
| `ENVIADO_PROTHEUS` | POST lote-enviar-protheus | Develsoft devolveu `ok:true`, ProcBord rodou (pode ter rejeições parciais) |
| `ERRO_PROTHEUS` | POST lote-enviar-protheus | HTTP não-2xx ou `body.ok:false` (falha geral, não roda parcial) |
| `RETORNADO` | POST lote-sincronizar | Todos os títulos do lote já têm retorno do banco (sem PENDENTE) |
| `DISPARADO` | Onda 3.4-3.6 (planejado) | Boleto disparado por WhatsApp/email |

##### Onda 2 — Envio ao Protheus (implementado em 2026-05-13)
- **Service**: [services/protheusCobranca.js](services/protheusCobranca.js) — wrapper de `POST {PROTHEUS_API_URL}/Cobranca/gerar-bordero` (REST custom Develsoft)
- **Endpoint**: [POST /financeiro/boleto-lote/:id/enviar-protheus](resources/financeiro/financeiro.boleto-lote-enviar-protheus.js)
- Pre-condição: lote em status `CRIADO` (não reenvia)
- Auth Basic com `PROTHEUS_API_USER/PROTHEUS_API_PASS` (mesmas creds do AprovaCompras). Timeout 60s, max 500 títulos/chamada
- Response grava `lote_protheus` (nº do bordero), contadores e `protheus_resposta` completa em jsonb pra auditoria. Audita CRITICO em sucesso, ALERTA em falha
- Sucesso parcial (`qt_rejeitados > 0` mas `qt_processados > 0`) **continua** `ENVIADO_PROTHEUS` — operador vê o detalhe na resposta

##### Onda 3 — Sincronização do retorno bancário (implementado)
- **Endpoint**: [POST /financeiro/boleto-lote/:id/sincronizar](resources/financeiro/financeiro.boleto-lote-sincronizar.js)
- Operador roda **FINA130/140** no Protheus pra processar o arquivo CNAB `.RET` do banco → atualiza E1_OCORREN, E1_NUMBOR, E1_NUMBCO, E1_BAIXA
- A Intranet **apenas consulta** SE1 (não parseia CNAB) em batches de 100 OR-clauses (limite ~2100 params do MSSQL)
- Mapeamento `MAP_OCORRENCIA` (E1_OCORREN → status interno): `02` REGISTRADO · `03/12/13/32/33/34` REJEITADO · `06/15/17` LIQUIDADO · `09/10` BAIXADO · `11/14/20/23/24` REGISTRADO. Códigos não mapeados viram `DESCONHECIDO` (operador investiga)
- Lógica de classificação: se `E1_BAIXA` preenchida E `E1_VALLIQ > 0` → LIQUIDADO independente do ocorren
- Vira `RETORNADO` quando todos títulos têm retorno (sem PENDENTE/NAO_ENCONTRADO/DESCONHECIDO)
- Audita INFO com stats por status

##### Onda 3.4-3.6 (planejado)
- Disparar boleto por WhatsApp/email a partir de `status_banco = 'REGISTRADO'`
- Gerar PDF do boleto próprio (não depende do ESF050)

#### Liberação Financeira · `/financeiro/liberacao-financeira` · perm 8006
> Substitui o processo manual: a operadora baixava a planilha de "carteira de pedidos" do **intranet PHP antigo**, montava uma tabela dinâmica filtrando status = "aguardando liberação do financeiro" + tipo + forma pgto + nº pedido, adicionava 2 colunas (Ações, Observações) e então liberava os pedidos no Protheus.

- **Página**: [LiberacaoFinanceira.tsx](../frontend_intranet_react/src/pages/Financeiro/LiberacaoFinanceira.tsx)
- **Tabela** ([migration 49](database/postgres/49-financeiro-liberacao.sql)): `tab_lib_financeira_anotacao` (1 row por pedido — `acoes` e `observacoes` texto livre, compartilhadas entre operadores, com quem/quando)
- **Endpoints**:
  - [GET /financeiro/liberacao](resources/financeiro/financeiro.liberacao-list.js) — carteira **agregada por pedido**, filtrada por `pedidos_estatus.estatus_cod = 20` ("Aguardando liberação do Financeiro"). Junta o financeiro de cada pedido (`total_pedido_sc6`, `pedidos_ra` pago, `pedidos_rf` a pagar) + tipo (SX5 Z1), forma/cond pgto, cliente, vendedor. Filtros: `tipo`, `formaPgto`, `busca` (pedido/cliente)
  - [POST /financeiro/liberacao/anotacao](resources/financeiro/financeiro.liberacao-anotacao.js) — upsert de ações/observações por pedido (auditado INFO)
  - [GET /financeiro/liberacao/:pedido](resources/financeiro/financeiro.liberacao-detalhe.js) — **detalhe ao clicar no pedido**: itens (SC6), observações (campos varchar do SC5 preenchidos — `C5_MENNOTA` é a mais comum) e **conhecimento** (anexos via AC9010+ACB010, `AC9_ENTIDA='SC5'`, `AC9_CODENT`=nº pedido). ⚠️ `C6_VDOBS` é `image` e não guarda texto útil — fica de fora
  - [GET /financeiro/liberacao/anexo/:codObj](resources/financeiro/financeiro.liberacao-anexo.js) — baixa um conhecimento via **TOTVS Documents** (`/api/crm/v1/documents/{InternalId}`, InternalId = 2 espaços + codObj). Mesma mecânica de [aprovacoes.anexo.js](resources/aprovacoes/aprovacoes.anexo.js), perm 8006. Auditado AVISO
  - [GET /financeiro/liberacao/credito/:cod/:loja](resources/financeiro/financeiro.liberacao-credito.js) — **painel 360 de análise de crédito** do cliente (ao clicar no nome). Junta cadastro de crédito da SA1 (risco, classe, `A1_LC`/`A1_LCFIN`, `A1_VENCLC`, maior compra) + **exposição ao vivo** (títulos em aberto SE1: total/vencido/a vencer/maior atraso + pedidos em carteira SC6) + limite disponível (`LC − exposição`, quando LC>0) + indicadores (atraso médio `A1_METR`, protestos `A1_TITPROT`, cheques devolvidos `A1_CHQDEVO`) + lista dos títulos. Critérios alinhados à Cobrança (`E1_VENCREA`, exclui `RA`/`NCC`, `E1_SALDO>0`). ⚠️ `A1_LC` costuma ser 0 nessa clientela (franquias/varejo) e o `A1_SALDUP` do cadastro fica defasado vs SE1 ao vivo — por isso a exposição é calculada em tempo real
- **Drawers (frontend)**: clicar no **nº do pedido** abre painel com Observações + Conhecimento (botão Baixar, download em blob) + Itens; clicar no **nome do cliente** abre o painel 360 de crédito (risco com badge colorido A→E, KPIs de exposição, lista de títulos)
- **Status do pedido** vem da view custom **`pedidos_estatus`** (derivada do SC9 `C9_BLEST`/`C9_BLCRED`): `10` Comercial (sem registro SC9) · **`20` Financeiro** (`C9_BLCRED='01'`) · `25` Financeiro Bloqueado · `30` Planejamento · `40` Formulação Financeira · `50` Estoque · `60` Faturamento · `99` Faturado
- **Data da Liberação Comercial** (coluna "Lib. Comercial"): quando o comercial libera (estatus 10→20), o SC9 é criado com `C9_BLCRED='01'` e `C9_DATALIB` = data dessa liberação. A lista traz `dataLibComercial = MAX(c9_datalib)` das linhas em estatus 20 (via `pedidos_estatus`). Mostrada na tabela logo após a Emissão e incluída no CSV
- ⚠️ A view legada `v_filapedidos`/`Z_FILAPEDIDOS` (colunas e2..e5) **não serve** — parou no pedido 039357 (não é mantida pros pedidos atuais)
- **Flags de apoio** (mesma lógica do relatório PHP):
  - **Verificar financeiro**: `geraTP = 'S'` E diferença financeira ≠ 0 (TP vs pago+a pagar)
  - **Não liberar (restrição de pagto)**: `recMinFat > 0` E `recMinFat > pago` (recebimento mínimo de faturamento não atingido)
- UI: tabela 1 linha/pedido, KPIs (pedidos, valor total, qtd verificar, qtd restrição), filtros, Ações/Observações editáveis inline (salvam on-blur), export CSV (CPF/CNPJ mascarado, datas dd/mm/yyyy)
- **Onda 1 (atual)**: organiza + rastreia. A **liberação efetiva continua no Protheus**
- **Onda 2 (planejada)**: botão "Liberar no Protheus" — executa a **sequência de liberação custom** (rotina Develsoft ligada à `v_filapedidos` / SC9 `C9_BLCRED`). Precisa de endpoint REST custom (mesmo padrão do `AprovaCompras/aprovar`) — aguarda spec + Develsoft. Prints da sequência a coletar com a operadora

---

### 3.6 Cobrança (módulo dedicado)

> Reescrito recentemente pra substituir a planilha operacional de inadimplência. Ver [intranet_cobranca.md](https://github.com/anthropics/claude-code) na auto-memória pra histórico.

**Tabelas próprias** (Postgres):
- `tab_cobranca_acao` — cada interação registrada (ligação, email, acordo, etc.)
- `tab_cobranca_anexo` — arquivos enviados anexos a uma ação ([migration 24](database/postgres/24-cobranca-anexo.sql))
- `tab_cobranca_comentario` — notas internas (não vão pro cliente)
- `tab_cobranca_status_cliente` — status comercial atual
- `tab_cobranca_atribuicao` — carteira manual por cliente (NORMAL/JURIDICO/NEGOCIACAO/OUTROS) [migration 10]
- `tab_cobranca_bu_equipe` — mapeamento BU → Equipe (substitui aba "apoio" da planilha) [migration 11]. Coluna `perfil` adicionada em [migration 40](database/postgres/40-cobranca-meta-perfil.sql) classifica equipes em **Corporativo / Atacado / Assistência Técnica / Varejo** pra cruzar com metas
- `tab_cobranca_meta_perfil` — metas de inadimplência por perfil (faixa min/max + flag tolerância zero) [migration 40]
- `tab_cobranca_whatsapp_*` — config + envios + log do disparo de WhatsApp ([migration 25](database/postgres/25-cobranca-whatsapp.sql))

**Status válidos** ([cobranca.status.js](resources/cobranca/cobranca.status.js)):
`REGULAR` · `NEGOCIANDO` · `PROMESSA` · `ACORDO_EM_ANDAMENTO` · `ACORDO_QUEBRADO` · `RETENCAO` · `DISTRATO` · `DEVOLUCAO` · `PROTESTO` · `JURIDICO` · `TERCEIRIZADA` · `NEGATIVADO` · `PERDA`

**Regras importantes**:
- Sempre exclui `E1_TIPO IN ('RA','NCC')` (adiantamentos e créditos do cliente — não são títulos cobráveis)
- Faturado = `E1_NUM <> ''` (tem número de NF)
- Equipe deriva do BU via mapeamento (não manual por cliente)
- Carteira é manual por cliente (depende de relação comercial)
- Aging: A vencer | 1-30 | 31-60 | 61-90 | 91-180 | 181-360 | 360+

#### Dashboard / Carteira de Cobrança · `/cobranca/dashboard` · perm 9001
- **Página**: [DashboardCobranca.tsx](../frontend_intranet_react/src/pages/Cobranca/DashboardCobranca.tsx)
- **Endpoint**: [GET /cobranca/dashboard](resources/cobranca/cobranca.dashboard.js)
- 5 KPIs (em aberto, a vencer, vencido, % inadimplência, ABC)
- 5 tabs: **Aging** (barras coloridas) · **Carteira/Equipe/BU** (3 cards) · **Curva ABC** (Pareto 80/15/5) · **Clientes** · **Títulos**
- Drawer ao clicar no cliente: editar carteira/observação + ver última ação + abrir página completa
- Filtros completos (cliente, UF, BU, formaPgto, carteira, equipe, aging, ação)
- Exporta CSV com 32 colunas

#### Painel de Cobrança · `/cobranca/painel` · perm 9001
- **Página**: [PainelCobranca.tsx](../frontend_intranet_react/src/pages/Cobranca/PainelCobranca.tsx)
- Visão antiga (vai ser deprecada eventualmente) — só vencidos com `diasMinimos` configurável
- Cliente/Título tabs

#### Cliente Cobrança · `/cobranca/cliente/:cod/:loja` · perm 9001 (não está no menu)
- **Página**: [ClienteCobranca.tsx](../frontend_intranet_react/src/pages/Cobranca/ClienteCobranca.tsx)
- 360°: dados, títulos abertos, timeline de ações, comentários, status
- Modais pra registrar/editar ação e atualizar status
- Só autor ou admin pode editar/excluir ação/comentário

#### BU ↔ Equipe · `/cobranca/bu-equipe` · perm 9001
- **Página**: [BuEquipe.tsx](../frontend_intranet_react/src/pages/Cobranca/BuEquipe.tsx)
- Tela de gestão dos 64 mapeamentos (substitui aba "apoio")
- Adicionar / editar inline / remover
- Endpoints: `GET/POST/DELETE /cobranca/bu-equipe`
- Quando aparecer "Sem equipe" no dashboard, adicionar aqui

#### Minhas Ações · `/cobranca/minhas-acoes` · perm 9003
- **Página**: [MinhasAcoes.tsx](../frontend_intranet_react/src/pages/Cobranca/MinhasAcoes.tsx)
- Fila do analista logado. Scope `pendentes` (promessas em aberto) ou `todas`

#### Envio WhatsApp (curadoria) · `/cobranca/envio-whatsapp` · perm 9004
- **Página**: [CobrancaWhatsApp.tsx](../frontend_intranet_react/src/pages/CobrancaWhatsApp/CobrancaWhatsApp.tsx)
- Permite ao operador **curar** o disparo: mostra os candidatos do dia (D-1, D0, D+1..D+3) com checkbox por título, antes de enviar
- Filtros: forma de pagamento (mostra só boletos / cartão / etc), busca, "ja enviado hoje"
- "Marcar todos" respeita o filtro de forma de pagamento
- Backend: [GET /cobranca/whatsapp-preview](resources/cobranca/cobranca.whatsapp-preview.js) e [POST /cobranca/whatsapp-enviar](resources/cobranca/cobranca.whatsapp-enviar.js)
- Mostra "última cobrança em" + status do envio anterior
- Idempotência diária: bloqueia reenvio do mesmo título no mesmo dia
- **Regra D+3 corrigida (2026-05-13)**: antes a janela era "atraso ≥ 3 dias" (`mode: 'desde'`), pegando até 1000+ dias de atraso. Agora é **janela 1 a 3 dias** (`mode: 'janela'`, `delta=-3, deltaMax=-1` em [services/scheduler.js:TIPOS](services/scheduler.js)). O label da aba foi atualizado pra "Atraso 1 a 3 dias". Cron das 09:00 e botão "Disparar agora" respeitam a nova janela. Histórico de envios mantém `tipo='D+3'` por idempotência.

#### Faturamento × Inadimplência (mensal) · perm 9001
- **Página**: [FaturamentoVsInadimplencia.tsx](../frontend_intranet_react/src/pages/Cobranca/FaturamentoVsInadimplencia.tsx)
- **Endpoint**: [GET /cobranca/faturamento-vs-inadimplencia](resources/cobranca/cobranca.faturamento-vs-inadimplencia.js)
- Cruza receita vs inadimplência **por mês** no período (1 linha por mês)
- CFOPs de venda hardcoded (mesma lista do equipes-ranking)

#### Ranking de Equipes · perm 9001 (tab no Dashboard de Cobrança)
- **Endpoint**: [GET /cobranca/equipes-ranking](resources/cobranca/cobranca.equipes-ranking.js)
- Cruza Faturamento × Inadimplência **agregado por equipe** (1 linha por equipe)
- **Filtro mês/ano** (`mesIni`/`mesFim` no formato `YYYYMM`) com retrocompat pra `anoMin`/`anoMax`
- Equipe deriva da BU via `tab_cobranca_bu_equipe`
- **Cada equipe tem `perfil`** (Corporativo / Atacado / AT / Varejo) e o response inclui `meta_min_pct`, `meta_max_pct`, `tolerancia_zero` e `status` (`dentro` / `abaixo` / `acima` / `tolerancia_violada` / `sem_meta`). Resposta também tem `resumoPerfis[]` agregado pros 4 cards do topo no frontend
- **UI** ([DashboardCobranca.tsx aba Equipes](../frontend_intranet_react/src/pages/Cobranca/DashboardCobranca.tsx)): 4 cards-resumo coloridos por status + 3 colunas novas na tabela (Perfil / Meta / Status badge)

#### Metas de Inadimplência por Perfil · perm 9001
- **Endpoints**: [GET /cobranca/meta-perfil](resources/cobranca/cobranca.meta-perfil.js) e [PUT /cobranca/meta-perfil/:perfil](resources/cobranca/cobranca.meta-perfil-upsert.js)
- 4 perfis seed (configurável):

| Perfil | Meta | Tolerância zero |
|---|---|---|
| Corporativo | 0% | sim (qualquer % > 0 vira "tolerancia_violada") |
| Atacado | até 2% | não |
| Assistência Técnica | até 2% | não |
| Varejo (longo prazo) | 6% a 8% | não — fora da faixa = "abaixo" ou "acima" |

- **Mapeamento equipe → perfil** definido em `tab_cobranca_bu_equipe.perfil` (seed na migration 40)

#### Borderô (integração com Protheus) — em construção
- **Endpoint Protheus** (custom Develsoft): `POST http://protheus.gnatus.com.br:8081/rest/Cobranca/gerar-bordero`
- Auth Basic (`admin:Gn@tu5` — mesmas credenciais do AprovaCompras)
- **Spec do contrato**: validações 400/413, payload `{filial, banco, operador, observacao, titulos[]}`, response `{ok, qtd_processados, qtd_rejeitados, lote, detalhes:[{prefixo, numero, parcela, cliente, loja, status, codigo_erro?, mensagem?}]}`
- **Script de teste**: [scripts/test-cobranca-gerar-bordero.js](scripts/test-cobranca-gerar-bordero.js) — 10 cenários (auth/validações/payload válido). Roda com `node scripts/test-cobranca-gerar-bordero.js`
- **Status atual** (2026-05-13): stub validado 10/10. `ProcBord` real implementado mas com pequeno ajuste pendente (echo de `prefixo/numero/parcela/cliente/loja` em `detalhes[]` mesmo nos erros, pra Intranet conseguir casar a rejeição com o item enviado)
- **Integração com a Intranet**: pendente. Plano: service `services/protheus-cobranca.js` + endpoint `POST /cobranca/bordero-enviar` + botão "Enviar ao Protheus" na tela de Envio de Boleto

#### Recuperados (tab no Dashboard) · perm 9001
- **Endpoint**: [GET /cobranca/recuperados](resources/cobranca/cobranca.recuperados.js)
- **Definição operacional**: "recuperado" = título com `E1_BAIXA` preenchida no período de baixa, onde o atraso na baixa foi `>= D+4` (`DATEDIFF(VENCREA, BAIXA) >= 4`). Considera **todas as formas de pagamento**.
- **Por que D+4 e não D+0?** Alinhado com o último lembrete WhatsApp (D+3). Antes disso o cliente está em "carência operacional" e não conta como recuperação ativa.
- **Visão escolhida — agrupa pelo MÊS DA BAIXA, não do vencimento**:
  - Exemplo: título venceu em `dez/2025`, foi pago em `mar/2026` (83 dias de atraso) → aparece em **mar/2026** com `atraso_medio_dias = 83`
  - Lente operacional: "**desempenho do time de cobrança no mês**" (quanto entrou no caixa em X)
  - Não temos a visão por safra (mês de vencimento) — decisão consciente: a operação prioriza performance mensal vs análise contábil retroativa
- **Fórmula da % de recuperação**: `recuperado / (recuperado + em_aberto_vencido)` — onde `em_aberto_vencido` é a soma de saldos vencidos no MESMO período de vencimento. Ou seja: do que ficou em atraso, quanto já foi pago.
- **Filtros**: `mesIni`/`mesFim` (YYYYMM, default 12 meses até hoje), `diasAtrasoMin` (default 4), `equipe`, `formaPgto`
- **KPIs no frontend**: total recuperado · taxa de recuperação (verde ≥70% / amarelo 50-70% / vermelho <50%) · atraso médio · em aberto vencido (denominador)
- **Visualizações**: ComposedChart (barras recuperado mensal + linha atraso médio) · tabela faixa de atraso · tabela forma pgto · top 15 clientes · BarChart por equipe

---

### 3.7 Apoio Gerencial (perms 5xxx)

> Faixa de permissões 5xxx. Módulo agrupa ferramentas executivas que cruzam vários domínios.

#### Gerador de Apresentações (IA) · `/apoio-gerencial/gerador-apresentacao` · perm 5001
- **Página**: [GeradorApresentacao.tsx](../frontend_intranet_react/src/pages/ApoioGerencial/GeradorApresentacao.tsx)
- Operador faz upload de **XLSX/CSV** (até 25MB), serviço lê e gera perfil estatístico, manda pra IA gerar apresentação executiva (capa + KPIs + gráficos + insights + próximos passos) renderizada em slides web
- **Pipeline backend**:
  1. [services/apoioPerfil.js](services/apoioPerfil.js) — `parsePlanilha(buffer)`: detecta header, tipos de coluna (`numero`/`data`/`categoria`/`texto`), agregados (min/max/media/soma), top valores
  2. [services/apoioApresentacao.js](services/apoioApresentacao.js) — monta prompt + chama IA via `services/ia.js`, valida JSON retornado (titulo + kpis[] + graficos[] obrigatórios)
  3. Resposta tem `tema_detectado`, `titulo`, `subtitulo`, `resumo_executivo`, `kpis[]`, `graficos[]` (tipo+aba+eixo+series), `insights[]`, `conclusao`, `proximos_passos[]`
- **Tabela** `tab_apoio_apresentacao` ([migration 32](database/postgres/32-apoio-gerencial.sql)): perfil + dados retornados pela IA + tokens + custo estimado em USD
- **Frontend**: 8 slides renderizados (capa + resumo + N gráficos + insights + conclusão), export PDF via `jspdf` + `html2canvas` (JPEG 0.82 + scale 1.5 + compress = ~3-5MB pra 8 slides)
- Histórico de apresentações geradas com tokens/custo/modelo
- Provedor de IA: ver [§4.7 IA Provider](#47-ia-provider-anthropic--openai)

#### Gestão de Contratos · `/apoio-gerencial/contratos` · perms 5002 (Ver) / 5003 (Editar) / 5004 (Aprovar Aditivos)
- **Página**: [Contratos.tsx](../frontend_intranet_react/src/pages/Contratos/Contratos.tsx)
- Cobre 6 tipos: `LOCACAO`, `FORNECIMENTO`, `MANUTENCAO`, `COMODATO`, `CLIENTE`, `PJ`
- **Tabelas** ([migration 36](database/postgres/36-contratos.sql)):
  - `tab_contrato` (cabeçalho — número auto `CT/AAAA/SEQ`, contraparte, vigência, valores, índice de reajuste, renovação automática, meta jsonb)
  - `tab_contrato_aditivo` (versionamento — VALOR/PRAZO/ESCOPO/REAJUSTE/MISTO, status RASCUNHO/APROVADO/CANCELADO)
  - `tab_contrato_anexo` (PDF/documentos — bytea inline, max 25MB)
  - `tab_contrato_alerta` (log de alertas enviados — UNIQUE evita duplicar no mesmo dia)
- **Status calculado em runtime** ([services/contratos.js](services/contratos.js)): RASCUNHO / AGUARDANDO / VIGENTE / VENCENDO (≤90d) / VENCIDO / RENOVADO / ENCERRADO
- **Onda 1**: CRUD + dashboard (pizza por tipo, top contraparte, próximos vencimentos) + anexos + autocomplete contraparte SA1/SA2 do Protheus
- **Onda 2** ([services/contratoAlertas.js](services/contratoAlertas.js) + [services/bcbIndices.js](services/bcbIndices.js)):
  - **Alertas D-90/D-60/D-30** por e-mail via cron `30 8 * * *` ([scheduler.js](services/scheduler.js))
  - **Reajuste automático** consultando API gratuita do BCB (IPCA 433, INPC 188, IGPM 189, IGPC 192, SELIC 4189). Calcula variação acumulada N meses por produto dos `(1 + v/100)`
  - **Aditivos** com fluxo de aprovação — RASCUNHO → APROVADO aplica novos valores no contrato pai
  - Endpoint manual `POST /contratos/alertas/disparar` (admin) pra rodar cron agora
- **Onda 3 prevista**: renovação automática, WhatsApp alongside e-mail, assinatura digital (Clicksign), faturamento automático (gerar SE1)
- 13 endpoints em `resources/contratos/`: list, dashboard, dominios, contraparte-search, detail, create, update, delete, anexo-upload/download/delete, aditivo-create/aprovar/delete, reajuste-preview/aplicar, alertas-disparar

---

### 3.8 Gerência

#### DRE Gerencial · `/gerencia/dre` · perm 10001
- **Página**: [DRE.tsx](../frontend_intranet_react/src/pages/Gerencia/DRE.tsx)
- **Endpoint**: [GET /gerencia/dre](resources/gerencia/gerencia.dre.js)
- Demonstrativo em regime competência por **emissão**
- **Receita bruta**: SF2+SD2 com CFOPs de venda
- **Deduções**: ICMS + PIS + COFINS + IPI (do D2_VAL*) + devoluções (SD1+SF1 CFOPs entrada)
- **CMV**: `SUM(D2_CUSTO1)` nas linhas de venda
- **Despesas operacionais** (entram em EBIT): naturezas SE2 com prefixos:
  - 204 Serviços Tomados · 205 Despesas com Pessoal · 206 Despesas Gerais · 207 Despesas Administrativas · 210 Investimentos · 212 Sócios · 213 Imobilizado/Consórcio
- **Compras de insumos** (NÃO entram em EBIT — informativo): 201 MP Nacional · 202 MP Importada · 203 Desembaraço (esses custos são absorvidos via CMV quando o produto é vendido)
- **Resultado financeiro** (perm 211): heurística por palavra-chave do histórico:
  - `JUROS|IOF|TAXA|TARIFA|CUSTAS|MULTA|MORA|CORRETAGEM` → entra como JUROS no DRE
  - `AMORTIZ|FINIMP|PRINCIPAL|INVOICE|RECOMPRA` → AMORTIZACAO (não impacta DRE — é redução de passivo)
  - sem padrão → PENDENTE (fica de fora até reclassificação contábil)
- Drill-down lazy de lançamentos por natureza (`/gerencia/dre/lancamentos?natureza=...`)
- Botão "Auditoria 211" gera CSV pra contabilidade reclassificar (`/gerencia/dre/auditoria-211`)

---

### 3.9 Controladoria

#### Estoque · `/controladoria/estoque` · perm 11001
- **Página**: [Estoque.tsx](../frontend_intranet_react/src/pages/Controladoria/Estoque.tsx)
- Valorização: `SB2.B2_QATU * SB2.B2_CM1` por armazém + tipo
- Filtro **dinâmico** de tipo (populado da própria resposta — pega tipos que realmente existem na base)
- Labels conhecidos: MP, MR, PA, PI, MC, EM, GN, SV, AI, DE, BN, OT, FE, UT (códigos extras aparecem só com o código)

#### Custo de Produto · `/controladoria/custo-produto` · perm 11002
- **Página**: [CustoProduto.tsx](../frontend_intranet_react/src/pages/Controladoria/CustoProduto.tsx)
- **Endpoint**: [GET /controladoria/custo/:produto](resources/controladoria/controladoria.custo-produto.js)
- Explosão recursiva da estrutura SG1010 (até 5 níveis) com validade `G1_INI <= hoje <= G1_FIM`
- Por componente: última compra (SD1+SF1), rateio de impostos por unidade × qtd do BOM, histórico paginado, variação %
- Coluna **Custo Médio** vem de `SB2.B2_CM1` (não `B1_CM1` que não existe na SB1 da Gnatus)
- KPIs: custo padrão (B1_CUSTD), custo médio (B2_CM1 max), custo calculado, Δ vs padrão
- Coluna **Subtotal** entre Custo Médio e Impostos pra deixar `Subtotal + Impostos = Custo c/ imp` explícito
- **Top 5 variação** (unitário e total) substitui o gráfico genérico — mostra os componentes que mais subiram/caíram %
- **Export XLSX (TOTVS)** — botão verde no header (só pra produtos PA): gera planilha 2-abas no mesmo formato da planilha de referência da Controladoria (modelo em [docs/Estrutura - 8125 ...xlsx](../docs/))
  - **Aba "Estrutura"** (27 colunas, espelha a planilha de referência): PA (Produto Pai, Descrição, Saldo Atual, C Unitário) + componente (Código, Descrição, Tipo, Grupo, Unidade, Saldo Atual, C Unitário, Quantidade, Custo Total, Armazém) + quebra de custo da última compra (Valor Un., Valor IPI Un., Valor Un.+IPI, Valor ICMS, Valor PIS, Valor COFINS, Valor Bruto) + Totais (Valor Bruto Total, IPI/ICMS/PIS/COFINS Total). Lista **plana** (componentes diretos; PIs como 1 linha)
    - Saldo Atual / C Unitário do componente vêm do **armazém 21** (B2_QATU/B2_CM1). Configurável via `?armazemCusto=NN`
    - **Valor Un.** = D1_VUNIT da última compra · **IPI/ICMS por unidade** = `D1_VALIPI`/`D1_VALICM` ÷ `D1_QUANT` (rateio da NF) · **PIS/COFINS por unidade** = Valor Un. × alíquota fixa (**1,65%** / **7,6%**) · **Valor Bruto** = Valor Un. + IPI Un. · **Totais** = valor unitário × Quantidade do BOM
    - PA (Saldo/C Unitário do cabeçalho): saldo = `SUM(B2_QATU)`, custo = `MAX(B2_CM1)` (o PA não fica no armazém de MP)
  - **Aba "Custo TOTVS"**: 22 colunas exatas (Cód PA, Descrição, Qtd Necessária, UM, Última Compra, Fornecedor `cod/loja`, NF `doc-serie`, Pedido, Qtde NF, vunit, Total, IPI, ICMS, COFINS, PIS, Frete, Custo Bruto Unit, Custo Liq c/ IPI, Custo Liq Unit) + linha de total
  - **Endpoint**: [GET /controladoria/custo/:produto/xlsx](resources/controladoria/controladoria.custo-produto-xlsx.js)
  - Fórmulas Custo TOTVS: `bruto = (Total + IPI + ICMS + Frete) / Qtde` · `liq c/IPI = (Total + IPI - ICMS - PIS - COFINS) / Qtde` · `liq = (Total - ICMS - PIS - COFINS) / Qtde`
  - ⚠️ Tanto "Estrutura" quanto "Custo TOTVS" refletem a **última compra real** — se houver NF com preço anômalo no Protheus, o valor anômalo aparece (caso real: ESPIGÃO 000085 com NF de R$ 2625/un)

#### Poder de Terceiros (Espelho Protheus) · `/controladoria/poder-terceiros` · perm 11003
- **Página**: [PoderTerceiros.tsx](../frontend_intranet_react/src/pages/Controladoria/PoderTerceiros.tsx) — aba "Espelho Protheus (SB6010)"
- **Endpoint**: [GET /controladoria/poder-terceiros](resources/controladoria/controladoria.poder-terceiros.js)
- Mostra o saldo de equipamentos em poder de clientes/fornecedores via `SB6010` (controle de poder de terceiros do Protheus)
- **Filtro por TES** (não CFOP): TES_INCLUIR `546` Comodato, `544/573` Conserto, `563` Industrialização, `656` Teste/Desenvolvimento — definidas pelo Fiscal
- **Top 20 Concentração de Valor**: terceiros com maior valor — exibe coluna **Notas Fiscais** com lista das NFs únicas (até 4 + tooltip com a lista completa)
- **Cards de categoria**: contagem em "notas" (NFs distintas), não em "itens" (linhas de SD2)
- **Filtros do detalhamento** (client-side, instantâneos): operadora · status · departamento · busca · período de emissão (de/até) · faixa de dias em poder · valor mínimo
- **Toggle "Visualizar por: Item / NF"**: agrupa as linhas por NF (1 linha por nota com soma de itens) — útil quando a planilha original do fiscal já vem por NF
- **Bug histórico (corrigido)**: a view `faturamento_cfop` agrupa por (filial, doc, série, cfop) — NFs com 2+ CFOPs apareciam duplicadas. Agora usa `EXISTS` em vez de `LEFT JOIN` (semântica de filtro idêntica, sem multiplicar linhas)

#### Poder de Terceiros (Controle Operacional) · `/controladoria/poder-terceiros` (aba "Controle Operacional") · perm 11003
- **Página**: [PoderTerceirosControle.tsx](../frontend_intranet_react/src/pages/Controladoria/PoderTerceirosControle.tsx)
- Substitui a planilha **CONTROLE DE EQUIPAMENTOS EM PODER DE TERCEIROS** do fiscal
- **Tabelas** ([migration 26](database/postgres/26-poder-terceiros-controle.sql)):
  - `tab_pt_envio` (cabeçalho do envio: destinatário, pedido, NF saída, finalidade, vigência)
  - `tab_pt_envio_item` (produtos do envio)
  - `tab_pt_finalizacao` (RETORNO/PARCIAL/VENDA/RENOVACAO/TROCA + nf_final + cfop_final + pedido_venda)
  - `tab_pt_envio_acao` (timeline de ações comerciais)
- **Importer XLSX** ([POST /controladoria/pt/import-excel](resources/controladoria/controladoria.pt-import-excel.js)):
  - **Layout 2026** suportado: aba "GERAL", header na linha 7, 2 colunas extras antes do DESTINATARIO (`ATUALIZADO EM:` e `NOVO VENCIMENTO`)
  - Detecção dinâmica: varre primeiras 15 linhas × 8 colunas procurando "DESTINATARIO" → mapeia tudo a partir dali (robusto a futuros deslocamentos)
  - `trim()` defensivo: Date solto vira null (antes virava string ICU enorme estourando varchar)
  - `toISODate()` aceita Date.toString() JS (`Mon Apr 25 2022 21:00:00 GMT-0300 (...)`)
  - Skip de linhas-rótulo (ATUALIZADO/RESPONSAVEL/TOTAL/VERDE/AMARELO/VERMELHO/GNATUS)
- **Migrations relacionadas**:
  - [33-pt-novas-colunas.sql](database/postgres/33-pt-novas-colunas.sql) — adiciona `atualizado_em_planilha` (date) e `novo_vencimento_obs` (varchar 200)
  - [34-pt-pedido-venda-amplo.sql](database/postgres/34-pt-pedido-venda-amplo.sql) — amplia `pedido_venda` pra varchar(200) (fiscal usa pra anotação livre tipo "RETORNO VIRTUAL, BAIXA COMO PERDA")

#### Estoque · Dashboards (Valor / Qualidade / Tendência) · perm 11004
3 dashboards de gestão analítica de estoque, todos sob a mesma permissão `11004`. Compartilham infraestrutura e drill-down.

**Pasta de páginas**: [src/pages/Controladoria/EstoqueDashboards/](../frontend_intranet_react/src/pages/Controladoria/EstoqueDashboards/)
- `EstoqueValor.tsx` — `/controladoria/estoque-valor`
- `EstoqueQualidade.tsx` — `/controladoria/estoque-qualidade`
- `EstoqueTendencia.tsx` — `/controladoria/estoque-tendencia`
- `components/` — `KpiCard`, `ChartCard`, `FiltrosEstoque`, `DrillDownDrawer` (compartilhados)

**Endpoints backend** ([resources/Controladoria/](resources/Controladoria/)):
- `GET /controladoria/estoque-valor` — KPIs + serie 12m + ABC + sem giro
- `GET /controladoria/estoque-qualidade` — giro/segurança/excesso/ruptura por produto
- `GET /controladoria/estoque-tendencia` — pedidos colocados × consumo + projeção
- `GET /controladoria/estoque-produto/:cod` — drill-down universal (ficha + saldo + histórico + últimas compras/vendas)
- `GET /controladoria/estoque-dominios` — listas pra filtros (tipos, armazéns NNR010, ano-mês disponíveis no snapshot)
- `GET/PUT /controladoria/estoque-parametros[/:tipo]` — CRUD lead time / nível de serviço / janela
- `POST /controladoria/estoque-snapshot-rodar?meses=N` — bootstrap manual do cache

**Cache PG** ([migration 38](database/postgres/38-estoque-dashboards.sql)):
- `tab_estoque_snapshot_mensal` — 1 row por (ano_mes, cod_produto, armazem) com saldo + saídas (vendas SD2 + consumo SD3) do mês
- `tab_estoque_parametros` — lead time / z (nível de serviço) / janela de demanda. NULL em `tipo_produto` = padrão global; sobrescreve por tipo

**Cache de metadados** ([migration 39](database/postgres/39-estoque-produto-meta.sql)):
- `tab_estoque_produto_meta` — 1 row por produto com `lead_time_dias` (B1_PE), descrição, tipo, grupo, unidade. Evita bater Protheus por produto em toda chamada do dashboard. **Atualizado pelo cron de snapshot.**

**Cron diário** ([services/scheduler.js:CRON_ESTOQUE_SNAPSHOT](services/scheduler.js)) — `0 3 * * *`:
- Roda `services/estoqueSnapshot.js` com `meses: 1` (refaz mês corrente)
- Bootstrap inicial precisa ser manual: `POST /controladoria/estoque-snapshot-rodar?meses=12` ou `node scripts/rodar-snapshot-estoque.js 12` (60-90s pra ~4k produtos)

**Service de cálculo** ([services/estoqueCalculo.js](services/estoqueCalculo.js)) — helpers puros:
- `classificarABC(itens, getValor)` — corte 80/15/5
- `calcularGiroAnual(saidas12m, estoqueMedio)` + `calcularCoberturaDias(giro)`
- `estatisticasDemanda(saidasMensais)` — média + desvio padrão populacional
- `calcularSegurancaEIdeal({demandaMedia, desvioPadrao, leadTimeDias, z})`
- `classificarCriticidade({qtdAtual, estoqueSeguranca, estoqueIdeal})` → `ruptura | risco | ideal | excesso`
- `classificarTendencia(consumoMedio, pedidosColocados)` → `aumento | reducao | neutro` (corte ratio 1.1/0.9)
- `projecaoLinear(serie, periodosFuturos)` — regressão linear simples
- `ultimosAnoMes(N)`, `anoMesCorrente()`, `anoMesAnterior(am)`

**Módulo VALOR** — KPIs financeiros + giro:
- KPIs: valor total, qtd itens, giro anual (12m rolling), cobertura em dias, Δ vs mês ant.
- ComposedChart 12m (barras valor + linha giro mensal)
- Curva ABC (line chart % acumulado) + cards por classe
- BarChart top 10 produtos por valor
- Tabelas: top sem giro (3/6/12 meses configurável) + classe A com giro abaixo da mediana
- Drawer drill-down ao clicar produto
- Export XLSX 5 abas + PDF

##### Fórmula de Giro e Cobertura (dias de estoque)
> Documento de negócio (linguagem não-técnica): [docs/explicacao-dias-de-estoque.md](../docs/explicacao-dias-de-estoque.md) — versão pronta pra enviar a suprimentos.

**Helpers**: [services/estoqueCalculo.js](services/estoqueCalculo.js) `calcularGiroAnual` + `calcularCoberturaDias`. **Endpoint**: [controladoria.estoque-valor.js](resources/controladoria/controladoria.estoque-valor.js).

- **Giro anual** (KPI card): `giro = Σ CMV_12m / estoque_médio_12m`
  - `Σ CMV_12m` = soma do CMV dos últimos 12 meses (`valor_saidas_mes`)
  - `estoque_médio_12m` = média de `valor_estoque` dos 12 meses
- **Cobertura em dias** (KPI card): `cobertura = 360 / giro_anual`
- **Equivalência**: `360 / (ΣCMV_12m / estoque_médio)` ≡ `30 / (CMV_médio_mensal / estoque_médio)` — pois `ΣCMV_12m = 12 × CMV_médio_mensal`. As duas formas dão o mesmo número.
- **CMV (não faturamento)**: `valor_saidas_mes` = `SD2.D2_QUANT × D2_CUSTO1` (vendas) + `SD3.D3_CUSTO1` (consumo produção). Comentário no código documenta a troca de D2_TOTAL → CMV (faturamento inflava o giro).
- **Estoque** valorado a custo: `SB2.B2_VATU1`.

⚠️ **Limitações conhecidas** (verificadas 2026-05-20):
1. **Série mensal do gráfico usa 1 mês isolado**, não média móvel: cada ponto = `30 / (CMV_do_mês / estoque_do_mês)`. Só o **card de KPI** usa a média de 12 meses.
2. **Estoque histórico é proxy**: o Protheus não guarda saldo histórico, então TODOS os 12 meses do snapshot usam a fotografia atual do SB2 (ver [estoqueSnapshot.js:7-9](services/estoqueSnapshot.js)). Como os 12 valores de estoque são idênticos, a "média de estoque" colapsa pro valor corrente — só o CMV varia mês a mês. Reconstruir saldo real exigiria refazer via SD3 (fora de escopo F1).
3. **Duplo arredondamento**: giro arredondado a 2 casas antes de `360/giro`, depois `Math.round`. Pequena imprecisão em produtos de giro muito alto/baixo.

**Módulo QUALIDADE** — equilíbrio do estoque:
- Fórmulas:
  - `consumo_lead_time = demanda_média × (lead_time / 30)`
  - `estoque_segurança = z × desvio_padrão × √(lead_time / 30)` (default z=1.65 ≈ 95%)
  - `estoque_ideal = consumo_lead_time + estoque_segurança`
  - Critérios: `qtd_atual=0` → ruptura · `< segurança` → risco · `> ideal × 1.10` → excesso · senão ideal
- KPIs clicáveis (filtram a tabela): Total / Ruptura / Risco / Ideal / R$ em excesso
- Heatmap tipo × criticidade (cores proporcionais), célula clicável
- BarChart R$ excesso por tipo
- Tabela com badge de criticidade
- Modal de **Parâmetros** pra editar lead time / z / janela por tipo ou global (`tab_estoque_parametros`)
- Lead time real vem de `B1_PE` quando >0; senão usa parâmetro do tipo, fallback global

**Módulo TENDÊNCIA** — projeção:
- Pedidos colocados = SC7 (compras emitidas) + SC2 (ordens de produção)
- Recebimentos previstos = SC7 com `C7_DATPRF` no mês (`C7_QUANT - C7_QUJE > 0`)
- Consumo = saídas do snapshot (SD2 vendas + SD3 RE0/RE1/RE5)
- Banner colorido com tendência: AUMENTO (laranja) · REDUÇÃO (verde) · NEUTRO (cinza)
- LineChart 3 séries (pedidos / consumo / recebimentos) com `ReferenceLine` "hoje" + projeção 3m tracejada
- AreaChart de saldo projetado 3 meses (saldo_atual + Σ delta_proj)
- Tabela "risco overstock" — produtos com pedidos pendentes > 6 meses de consumo
- Drawer drill-down

**Decisões de regra** (locked com user em 2026-05-12):
- Filtrar por **B1_TIPO** (PA/MP/EM/etc) e separar por armazém (NNR010)
- Lead time: **B1_PE** (Protheus) com fallback no parâmetro
- z padrão **1.65** (95%), janela demanda **6 meses**
- "Sem giro" configurável: 3/6/12 meses
- Consumo Tendência inclui MP (SD3) + vendas (SD2)
- Pedidos Tendência inclui SC2 (produção) + SC7 (compras)
- 1 perm única **11004** pros 3 dashboards

##### Parâmetros Manuais por Produto (Override) · `/controladoria/estoque-parametros-manuais` · perm 11004
- **Página**: [EstoqueParametrosManuais.tsx](../frontend_intranet_react/src/pages/Controladoria/EstoqueDashboards/EstoqueParametrosManuais.tsx)
- **Migration**: [48-estoque-produto-meta-override.sql](database/postgres/48-estoque-produto-meta-override.sql) — estende `tab_estoque_produto_meta` com `lead_time_override`, `demanda_mensal_manual`, `estoque_seguranca_manual`, `observacao_manual`, `atualizado_por`, `manual_em`
- **Endpoints**:
  - [GET /controladoria/estoque-override-list](resources/controladoria/controladoria.estoque-override-list.js) — lista produtos com override ativo
  - [GET /controladoria/estoque-override-get/:cod](resources/controladoria/controladoria.estoque-override-get.js)
  - [POST /controladoria/estoque-override-upsert](resources/controladoria/controladoria.estoque-override-upsert.js)
  - [DELETE /controladoria/estoque-override-delete/:cod](resources/controladoria/controladoria.estoque-override-delete.js)
  - [GET /controladoria/produtos-busca?q=...](resources/controladoria/controladoria.produtos-busca.js) — autocomplete SB1
- **Estratégia**: estende `tab_estoque_produto_meta` (já mantida pelo cron) com colunas `*_override`/`*_manual`. Cron diário continua atualizando `lead_time_dias` do B1_PE; backend usa o **override se ≠ NULL**, fallback no automático
- Permite cadastro manual de lead time / demanda média mensal / estoque de segurança por produto + observação livre
- Usado quando o cálculo automático (B1_PE + média do snapshot) não reflete a realidade (ex: produto novo sem histórico, item sazonal, política comercial diferente)

---

### 3.10 Produção

> Substitui o **Pipefy "01 | REGISTRO HISTÓRICO DO PRODUTO"** (Develsoft). Cada Ordem de Produção (OP) percorre 12 etapas. Cada etapa tem responsável, status, campos específicos, anexos (SharePoint) e log de transições pra cálculo de tempos/produtividade.

**Permissões**:
- `14001` Produção - Registro (operador comum: cria registros, atualiza etapas atribuídas)
- `14002` Produção - Admin / Gestão (gestores: vê todas OPs, dashboard de gestão, cadastra instruções)
- `14003` Produção - Dashboard (visualização do dashboard apenas)

**Tabelas**:
- [migrations 17/18](database/postgres/17-producao-registro.sql) — `tab_producao_registro`/`tab_producao_op` (legado, mantido)
- Tabelas novas do fluxo 12-etapas (criadas em migrations sub-numeradas anteriormente):
  - `tab_prod_registro` (cabeçalho da OP — produto, lote, OP_Protheus, status: aberto/concluido/cancelado)
  - `tab_prod_registro_etapa` (1 row por etapa por registro — código, status, responsavel_id, dados_extras jsonb)
  - `tab_prod_registro_anexo` (anexos da etapa — ver migração 45 abaixo)
  - `tab_prod_registro_etapa_log` ([migration 46](database/postgres/46-producao-gestao.sql)) — log de transições de status (de → para, mudou_por, mudou_em). Popula sempre que etapa-update muda status. Etapas existentes NÃO geram histórico retroativo.
  - `tab_prod_instrucao` ([migration 47](database/postgres/47-producao-instrucoes.sql)) — Instruções de Trabalho (1 doc SharePoint por produto/etapa)

**12 etapas** (catálogo em [resources/producao/_etapas.js](resources/producao/_etapas.js) — `_` prefix faz o resource loader ignorar):
1. Separação de Materiais (`tipo_separacao`, `materiais_falta`)
2. Impressão do Rótulo (`rotulagem_url`)
3. **Liberação de Início de Processo** (checklist de 8 requisitos: limpeza, ferramentas, calibração, docs, instruções, treinamento, ambiente — anti-erro de bypass)
4. Montagem
5. Inspeção e Teste Montagem
6. Inspeção e Testes Finais
7. Embalagem e Rotulagem
8. Inspeção da Embalagem e Rotulagem
9. Liberação Final
10. Apontamento Protheus (SD3)
11. Aguardando Coleta (`armazem`, `localizacao` — `00` PA / `12` AT)
12. Concluído

#### Registros de Produção · `/producao/registros` + `/producao/registros/:id` · perm 14001/14002
- **Listagem**: [RegistrosProducao.tsx](../frontend_intranet_react/src/pages/Producao/RegistrosProducao.tsx)
- **Detalhe (kanban de etapas)**: [RegistroProducao.tsx](../frontend_intranet_react/src/pages/Producao/RegistroProducao.tsx)
- **Endpoints**:
  - [GET /producao/registros](resources/producao/producao.registros.js) — lista todas OPs com filtros
  - [GET /producao/registro/:id](resources/producao/producao.registro.js) — detalhe (cabeçalho + 12 etapas + responsável + anexos + instruções linkadas pelo produto)
  - [POST /producao/registro-criar](resources/producao/producao.registro-criar.js) — abre nova OP
  - [DELETE /producao/registro-delete](resources/producao/producao.registro-delete.js) — cancela OP
  - [POST /producao/etapa-update](resources/producao/producao.etapa-update.js) — muda status/responsável/dados de uma etapa (gera log)
  - [GET /producao/ops-disponiveis](resources/producao/producao.ops-disponiveis.js) — OPs do Protheus SC2010 prontas pra abrir registro
  - [GET /producao/usuarios-equipe](resources/producao/producao.usuarios-equipe.js) — lista de colaboradores aptos a serem responsáveis
  - [POST /producao/sync](resources/producao/producao.sync.js) — sincroniza OPs do Protheus
  - [GET /producao/pdf-final](resources/producao/producao.pdf-final.js) — gera PDF consolidado do registro completo

#### Anexos da etapa (SharePoint) — `producao.anexo-*` · perm 14001
- **Service**: [services/graphFiles.js](services/graphFiles.js) — wrapper Microsoft Graph pra upload/download/delete em **SharePoint SITE** (`https://gnatus.sharepoint.com/sites/Pipefy`)
- **Migration**: [45-producao-anexo-sharepoint.sql](database/postgres/45-producao-anexo-sharepoint.sql) — estende `tab_prod_registro_anexo` com `origem` (`url_externa` legacy / `sharepoint`), `sharepoint_drive_id/item_id/path`, `nome_original`, `mime_type`, `tamanho_bytes`
- ⚠️ **NÃO usa OneDrive pessoal** — `Application permissions` no Graph não acessam personal sites de forma confiável. Destino é SharePoint Site dedicado
- Requer permission de **aplicativo** `Files.ReadWrite.All` (ou `Sites.Selected` + grant restrito) com admin consent
- `.env`: `GRAPH_SP_HOSTNAME` (default `gnatus.sharepoint.com`), `GRAPH_SP_SITE_PATH` (default `/sites/Pipefy`)
- **Limite atual**: arquivo até 4MB no PUT direto. > 4MB precisa upload session (não implementado — F1 não mira nisso)
- Endpoints: [anexo-upload](resources/producao/producao.anexo-upload.js), [anexo-download](resources/producao/producao.anexo-download.js), [anexo-delete](resources/producao/producao.anexo-delete.js), [anexo-add](resources/producao/producao.anexo-add.js) (link externo só)

#### Dashboard de Produção · `/producao/dashboard` · perm 14001/14002/14003
- **Página**: [DashboardProducao.tsx](../frontend_intranet_react/src/pages/Producao/DashboardProducao.tsx)
- **Endpoint**: [GET /producao/dashboard](resources/producao/producao.dashboard.js)
- KPIs operacionais: ops em andamento, atrasadas, eficiência, ocupação por colaborador

#### Gestão da Produção · `/producao/gestao` · perm 14002
- **Página**: [GestaoProducao.tsx](../frontend_intranet_react/src/pages/Producao/GestaoProducao.tsx)
- **Endpoints**:
  - [GET /producao/gestao/dashboard](resources/producao/producao.gestao-dashboard.js) — KPIs + ranking colaboradores + tempo médio + gargalo por etapa + série temporal
  - [GET /producao/gestao/em-andamento](resources/producao/producao.gestao-em-andamento.js) — lista atual de etapas em aberto
- Filtros via query: `dataIni`/`dataFim` (default últimos 30d), `colaboradorId`, `etapaCodigo` (1..12)
- Calcula tempos usando `tab_prod_registro_etapa_log` — transições aprovado/reprovado vs em_andamento, dia a dia

#### Cadastro de Instruções de Trabalho · `/producao/instrucoes` · perm 14002
- **Página**: [CadastroInstrucoes.tsx](../frontend_intranet_react/src/pages/Producao/CadastroInstrucoes.tsx)
- **Endpoints**:
  - [GET /producao/instrucoes-list](resources/producao/producao.instrucoes-list.js) — catálogo completo
  - [GET /producao/instrucoes-produto/:codigo](resources/producao/producao.instrucoes-produto.js) — instruções de 1 produto
  - [POST /producao/instrucoes-upload](resources/producao/producao.instrucoes-upload.js) — sobe arquivo pro SharePoint + grava metadata
  - [GET /producao/instrucao-download/:id](resources/producao/producao.instrucao-download.js) — proxy de download
  - [DELETE /producao/instrucoes-delete/:id](resources/producao/producao.instrucoes-delete.js) — remove SharePoint + row
- **Migration**: [47-producao-instrucoes.sql](database/postgres/47-producao-instrucoes.sql)
- **Storage**: `SharePoint /sites/Pipefy/Documents/Instrucoes Produto/{codigo}/`
- **Modelo**: 1 instrução por (produto_codigo, etapa_codigo). `etapa_codigo NULL` = instrução geral do produto. UNIQUE INDEX garante uma instrução por par
- **Linkagem dinâmica**: quando OP é aberta, o detalhe consulta as instruções do produto e exibe no accordion da etapa correspondente. **Editar a instrução impacta todas as OPs (passadas e futuras) imediatamente** — substitui o "database de produtos" do Pipefy

---

### 3.11 Universidade Corporativa

**Permissões** (em [resources/universidade/_perms.js](resources/universidade/_perms.js)):
- `15001` Universidade - Aluno (consome cursos, faz quiz)
- `15002` Universidade - Instrutor (cria/edita cursos, vê matriculados)
- `15003` Universidade - Admin (gestão completa, catálogo, quiz admin)

**Tabelas** ([migrations 19/20/23](database/postgres/19-universidade.sql)):
- `tab_uni_curso`, `tab_uni_aula`, `tab_uni_categoria`
- `tab_uni_matricula`, `tab_uni_progresso` (corrigido em [migration 23](database/postgres/23-universidade-fix-progresso.sql) — UNIQUE composto por user+aula)
- `tab_uni_quiz`, `tab_uni_quiz_questao`, `tab_uni_quiz_tentativa`, `tab_uni_quiz_resposta`

#### Catálogo · `/universidade` · perm 15001/15002/15003
- **Página**: [Catalogo.tsx](../frontend_intranet_react/src/pages/Universidade/Catalogo.tsx)
- **Endpoints**: [cursos](resources/universidade/universidade.cursos.js), [categorias](resources/universidade/universidade.categorias.js), [matricular](resources/universidade/universidade.matricular.js)

#### Meus Cursos · `/universidade/meus-cursos` · perm 15001
- **Página**: [MeusCursos.tsx](../frontend_intranet_react/src/pages/Universidade/MeusCursos.tsx)
- **Endpoint**: [GET /universidade/meus-cursos](resources/universidade/universidade.meus-cursos.js)
- Lista cursos matriculados com % de progresso. Botão "Certificado" se concluído

#### Detalhe do Curso (player) · `/universidade/curso/:id` · perm 15001/15002/15003
- **Página**: [CursoDetalhe.tsx](../frontend_intranet_react/src/pages/Universidade/CursoDetalhe.tsx)
- **Endpoints**: [curso](resources/universidade/universidade.curso.js), [aula-concluir](resources/universidade/universidade.aula-concluir.js)
- Player de vídeo/conteúdo + tracking de tempo assistido por aula

#### Quiz · `/universidade/curso/:cursoId/quiz` + `/universidade/tentativa/:id` · perm 15001
- **Páginas**: [QuizAluno.tsx](../frontend_intranet_react/src/pages/Universidade/QuizAluno.tsx) + [RevisaoTentativa.tsx](../frontend_intranet_react/src/pages/Universidade/RevisaoTentativa.tsx)
- **Endpoints**: [quiz](resources/universidade/universidade.quiz.js), [quiz-iniciar](resources/universidade/universidade.quiz-iniciar.js), [quiz-finalizar](resources/universidade/universidade.quiz-finalizar.js), [tentativa](resources/universidade/universidade.tentativa.js)
- Quiz no fim do curso com nota mínima. Tentativa fica salva pra revisão posterior

#### Certificado · perm 15001
- **Endpoint**: [GET /universidade/certificado/:cursoId](resources/universidade/universidade.certificado.js) — gera PDF com nome/curso/data/nota

#### Admin · `/universidade/admin` · perm 15002/15003
- **Página**: [AdminUniversidade.tsx](../frontend_intranet_react/src/pages/Universidade/AdminUniversidade.tsx)
- **Endpoints CRUD**: [curso-criar](resources/universidade/universidade.curso-criar.js), [curso-editar](resources/universidade/universidade.curso-editar.js), [aula-criar](resources/universidade/universidade.aula-criar.js), [aula-editar](resources/universidade/universidade.aula-editar.js), [aula-deletar](resources/universidade/universidade.aula-deletar.js), [quiz-criar](resources/universidade/universidade.quiz-criar.js), [quiz-editar](resources/universidade/universidade.quiz-editar.js), [quiz-admin](resources/universidade/universidade.quiz-admin.js), [questao-criar](resources/universidade/universidade.questao-criar.js), [questao-deletar](resources/universidade/universidade.questao-deletar.js), [curso-matriculados](resources/universidade/universidade.curso-matriculados.js)

---

### 3.12 Planejamento

#### Disponibilidade · `/planejamento/disponibilidade` · perm 3001
- **Página**: [Disponibilidade.tsx](../frontend_intranet_react/src/pages/Disponibilidade/Disponibilidade.tsx)
- Análise de disponibilidade de itens MR/MP no estoque vs demanda
- Roda em SB2 + SC6 (itens de pedido) + SC7 (pedidos de compra)

---

### 3.13 Expedição

> Substitui o legado PHP. Bordero em tabela `TAB_EXP_BORDERO` (1 linha por volume, formato "001/003"). Ao confirmar, gera XLSX pro **configurador da impressora Zebra**.

#### Notas a Expedir · `/expedicao/notas` · perm 12001
- **Página**: [NotasExpedir.tsx](../frontend_intranet_react/src/pages/Expedicao/NotasExpedir.tsx)
- **Endpoint principal**: [GET /expedicao/notas](resources/expedicao/expedicao.notas.js)
- SF2010 série 1 filial 01 com `z1_expedic IS NULL`, NFs com ao menos 1 item com CFOP fora da lista de proibidos
- Linha verde quando NF já está no bordero. Botão "Adicionar/Remover" alterna inline
- **DIFAL e FCP**: agregados via subquery `SUM(D2_DIFAL)` e `SUM(D2_VALFECP)` por NF. Coluna **DIFAL** em vermelho quando > 0, **FCP** em laranja. KPIs adicionais "DIFAL total" e "FCP total" aparecem no topo se houver
- **Filtros**: busca, data mínima, **checkbox "Só com DIFAL"** mostra contagem (ex 17 NFs)
- **Bug duplicação corrigido**: a view `faturamento_cfop` agrupa por (filial, doc, série, **cfop**) — NFs mistas (ex 087577 com 6105 + 6106) viravam N linhas no LEFT JOIN. Agora usa `EXISTS` (mesma semântica de filtragem, sem duplicar)
- **Prévia da NF**: clique no número da NF abre **drawer lateral** ([endpoint GET /expedicao/notas/:doc/:serie](resources/expedicao/expedicao.nf-detalhe.js)) com cabeçalho + destinatário (CNPJ, endereço, cidade/UF/CEP, telefone, email) + transportadora + tabela de itens (cód, descrição, qtd, vunit, total, CFOP, DIFAL) + totais (mercadorias, bruto, ICMS, IPI, PIS, COFINS, DIFAL, FCP)
- **Campos PIS/COFINS no SF2 da Gnatus**: `F2_VALPIS` / `F2_VALCOFI` (não existem `F2_PIS` / `F2_COFINS`)

#### Bordero de Etiquetagem · `/expedicao/bordero` · perm 12002
- **Página**: [BorderoEtiquetagem.tsx](../frontend_intranet_react/src/pages/Expedicao/BorderoEtiquetagem.tsx)
- Visualiza linhas atuais agrupadas por NF (1 linha por volume)
- "Exportar XLSX" gera arquivo no formato Zebra via `exceljs`

---

### 3.14 RH

#### Termo de Responsabilidade · perm 1027 (mesma do equipamentos)
- **Endpoint principal**: [resources/rh/rh.termo-log.js](resources/rh/rh.termo-log.js)
- **Tabelas relacionadas**:
  - `tab_termo_equipamento` (cabeçalho do termo — colaborador, acessórios, condições)
  - `tab_termo_dispositivo` ([migration 30](database/postgres/30-termo-dispositivo.sql)) — **1 termo agora aceita N dispositivos**
- Backfill automático: termos antigos com 1 equipamento ficam como `ordem=0` na tabela filha (`tab_termo_dispositivo`)
- Aceita body com `dispositivos[]` OU campos chapados (retrocompatível)
- Cada dispositivo gera 1 row em `tab_termo_dispositivo` E 1 em `tab_equipamento_atual`
- Acessórios são do termo (não duplicam por dispositivo) — `acessoriosTexto()` no frontend monta string CSV final
- Bug histórico (corrigido): print do termo tinha quadrado branco por causa do `.sidebar-mobile-toggle` não escondido em `@media print` — adicionado `display:none` nas 3 classes do menu mobile (toggle/close/backdrop)

---

### 3.15 Perfil (todos usuários logados)

#### Alterar Senha · `/alterar-senha` · perm `[]`
- Sem restrição. Bcrypt hash em `tab_intranet_usr.senha`

#### Reserva de Sala · `/perfil/reserva-sala` · perm 5001
- **Página**: [ReservaSala.tsx](../frontend_intranet_react/src/pages/ReservaSala/ReservaSala.tsx)
- Microsoft Graph API (não usa backend pra isso). Login via `loginRedirect` (popup quebra com BrowserRouter)
- Scopes: `User.Read`, `Calendars.ReadWrite`, `Place.Read.All`, `OnlineMeetings.ReadWrite`, `MailboxSettings.Read`
- Cria reunião no calendário do user com sala como `type: resource`

#### Cofre de Senhas · `/perfil/cofre` · perm 7001
- **Página**: [Cofre.tsx](../frontend_intranet_react/src/pages/Cofre/Cofre.tsx)
- **Zero-knowledge**: chave mestra derivada da senha do user (PBKDF2 600k iterations) — nunca sai do browser
- Cifragem **AES-GCM** por item (título, URL, usuário, senha, notas — todos criptografados separadamente)
- **Recovery key** (32 chars formato `A3FR-7K2P-...`) entregue na configuração inicial
- **Backup IT** em `tab_sys_audit_meta` (nome obfuscado): blob criptografado com `COFRE_BACKUP_KEY` do `.env` — permite recuperação por admin se user esquecer senha + recovery key
- ⚠️ Se vazar `COFRE_BACKUP_KEY` junto com o DB, quebra zero-knowledge

---

## 4. Integrações

### 4.1 Microsoft 365 / Entra ID
- App Registration: `Intranet GNATUS - Reserva de Salas`
- Tenant: `58aad519-4be3-424e-ac16-0ecc35a70418`
- Client ID: `6e235550-207c-46a9-9ee3-28e8bca82376`
- Plataforma: **Single-page application (SPA)** — usa PKCE (não Implicit nem Web)
- Redirect URIs: `http://localhost:5173`, `https://intranew.gnatus.com.br`
- Frontend `.env.local` / `.env.production`: `VITE_MS_CLIENT_ID`, `VITE_MS_TENANT_ID`
- ⚠️ **Vite `VITE_*` são compile-time** — precisa rebuild a cada mudança

### 4.2 Active Directory local
- DC: `SRV-GNT-ADDS01.gnt.local` em `172.31.255.100`
- Acesso da VPS via VIP NAT do FortiGate: `200.15.18.119:36363` → `172.31.255.100:636` (LDAPS)
- DC tem regra `New-NetFirewallRule LDAPS-VPN-VPS-Intranet` permitindo source `177.7.37.251/32`
- Backend `.env`: `AD_URL=ldaps://200.15.18.119:36363`, `AD_BASE_DN=DC=gnt,DC=local`, etc.
- Cliente: [`ldapts`](https://www.npmjs.com/package/ldapts) com `tlsOptions: { rejectUnauthorized: false }` (cert self-signed)

### 4.3 SAP Protheus
- Host (interno): `192.168.1.140:1433` — acessível da VPS via NAT do FortiGate (`179.108.181.12:1433`)
- Backend `.env`: `PROTHEUS_SERVER=ddns.gnatus.com.br` (continua usando NAT, VPN tunnel não foi adotada por complexidade)
- DB: `protheus`. Filial padrão: `'01'`
- Tabelas mais usadas em [protheus_schema.md](../../.claude/.../memory/protheus_schema.md)
- ⚠️ Sempre `WITH (NOLOCK)` (read-only) e `RTRIM(...)` em strings (Protheus armazena padded)

### 4.4 PostgreSQL (local da intranet)
- Local dev: `localhost:5432` via Docker container `intranet-pg` (postgres:16-alpine)
- Prod (VPS): `localhost:5432` (instalado direto, não Docker)
- DB: `intranet` / user: `intranet` / senha: `jgZqJ57GExNXtBvAdT6tuiFV` (prod) ou `intranet_dev_2026` (dev)
- ⚠️ Migrations devem ser aplicadas como user `intranet` (não `postgres`) — senão o backend não tem permissão pras tabelas. Se erro, rodar `GRANT ALL ON tab_xxx TO intranet`

### 4.5 FALEmais (PABX)
- Sigma API + Gravacoes API
- Token fixo no `.env`: `FALEMAIS_TOKEN`
- Click-to-call: `POST sigma/v1/...` com ramal do user e número do cliente

### 4.6 SMTP
- Prod: config completa em `.env` (`SMTP_HOST/PORT/USER/PASS/FROM`)
- Dev: MailHog em `localhost:1025`
- Service: [services/emailService.js](services/emailService.js) — `sendEmail({ to, subject, text, html, cc, bcc })` genérico + `sendVerificationEmail(to, codigo)` específico
- Uso: reset de senha + alertas de contrato (cron diário 08:30)

### 4.7 IA Provider (Anthropic / OpenAI)
- **Service**: [services/ia.js](services/ia.js) — abstração que roteia por env `IA_PROVIDER=anthropic|openai`
- Interface uniforme: `chat({system, messages, maxTokens, temperature})` e `chatJson({...})` (parseia `dados` automaticamente, tolera ` ```json ` ao redor)
- **Anthropic (Claude)**: `POST https://api.anthropic.com/v1/messages` com `x-api-key` + `anthropic-version: 2023-06-01`
  - `.env`: `ANTHROPIC_API_KEY=sk-ant-api03-...` + `ANTHROPIC_MODEL=claude-sonnet-4-5-20250929`
  - JSON mode via prompt (Anthropic não tem JSON mode formal)
- **OpenAI (GPT)**: `POST https://api.openai.com/v1/chat/completions` com `Authorization: Bearer ...`
  - `.env`: `OPENAI_API_KEY=sk-proj-...` + `OPENAI_MODEL=gpt-4o-mini`
  - JSON mode formal via `response_format: { type: 'json_object' }` (exige palavra "json" em alguma message)
- **Pricing tracking**: tabela hardcoded em USD/1M tokens; cada chamada calcula custo estimado e devolve em `r.custo`
  - Sonnet 4.5: $3 in / $15 out (~$0.045 por apresentação)
  - GPT-4o-mini: $0.15 in / $0.60 out (~$0.003 por apresentação — 15x mais barato)
- **Usado por**: Apoio Gerencial → Gerador de Apresentações
- ⚠️ **Comum colar a chave com prefixo duplicado** (`sk-ant-api03-sk-ant-api03-XXX`). Diagnóstico: `printf "len=%s" "${#ANTHROPIC_API_KEY}"` deve dar 108 (não 121)

### 4.8 BCB Séries Temporais
- **Service**: [services/bcbIndices.js](services/bcbIndices.js) — cliente das Séries Temporais do Banco Central
- Endpoint público gratuito: `https://api.bcb.gov.br/dados/serie/bcdata.sgs.{codigo}/dados?formato=json&dataInicial=DD/MM/YYYY&dataFinal=DD/MM/YYYY`
- Códigos suportados: `IPCA=433`, `INPC=188`, `IGPM=189`, `IGPC=192`, `SELIC=4189`
- `variacaoAcumulada(indice, meses)`: calcula `(1+v/100)` produto pra inflação acumulada
- **Cache em memória** TTL 12h (índices mudam 1x/mês)
- **Usado por**: Gestão de Contratos → reajuste automático
- Validado: IPCA 12m = +4,14%, IGPM 12m = +0,62% (Mai/2026)

### 4.9 TRPWSIMP — TOTVS Template de Importação
- **Service**: [services/trpwsimp.js](services/trpwsimp.js)
- Cliente do **MIT072** (Template Generic de Importação) do Protheus — REST nativo TOTVS
- Catálogo de **47+ IDs** hardcoded (SA1, SA2, SB1, SC5, SF6, SD1, SE1, SE2, etc)
- Auth: Basic Auth (mesmas credenciais Protheus REST)
- Endpoint `POST {PROTHEUS_API_URL}/wsTRPWSIMP/run` com payload JSON contendo `id`, `tabela`, `titCampos[]`, `nomCampos[]`, `dados[][]`
- Retorna `STATUS.TOTAL`, `STATUS.ATUALIZADOS`, `STATUS.NAO_ATUALIZADOS`, `STATUS.DURACAO` + log de inconsistências
- **Usado por**: Tecnologia → Importação Protheus

### 4.10 SURI WhatsApp (via Fluig PHP)
- **Service**: [services/suri.js](services/suri.js)
- Cliente do **Gupshup/SURI** mediado pelo **Fluig PHP da Develsoft** (`172.31.255.51`) — Gnatus não chama Gupshup direto
- Endpoint: `POST {SURI_BASE_URL}/api/messages/send` com Basic Auth (`gnatus-fluig`/`@Senha1232019`)
- Templates aprovados pela Meta com placeholders `{{1}}, {{2}}, ...` substituídos por nome/NF/valor/vencimento
- Função `normalizePhone(rawPhone)` remove zeros, adiciona DDI 55, valida 12-13 dígitos
- **Usado por**: Cobrança WhatsApp (cron diário) + Cobrança Envio WhatsApp (curadoria operador)

### 4.11 Anthropic / Claude Code (este manual)
- O próprio assistente que escreveu/escreve este manual usa Claude API
- Integração específica do **assistente de desenvolvimento** (não confundir com o IA Provider do Apoio Gerencial)

### 4.12 Microsoft Graph — SharePoint Files
- **Service**: [services/graphFiles.js](services/graphFiles.js) — cliente Microsoft Graph pra upload/download/delete de arquivos em **SharePoint Site**
- Destino: `https://gnatus.sharepoint.com/sites/Pipefy` (não OneDrive pessoal — Application permissions não acessam personal sites confiável)
- Permission de **aplicativo**: `Files.ReadWrite.All` (ou `Sites.Selected` + grant restrito) com admin consent
- `.env`: `GRAPH_SP_HOSTNAME` (default `gnatus.sharepoint.com`), `GRAPH_SP_SITE_PATH` (default `/sites/Pipefy`). Reusa `M365_TENANT_ID`/`M365_CLIENT_ID`/`M365_CLIENT_SECRET`
- Auth via `@azure/msal-node` (Confidential Client) + cache interno com margem 60s
- **Limite**: 4MB no PUT direto (acima precisa upload session — não implementado)
- **Usado por**: Produção (anexos de etapas) + Produção (instruções de trabalho)

### 4.13 Protheus REST (Develsoft — endpoints custom)
- **Wrapper services**:
  - [services/protheus.js](services/protheus.js) — MSSQL Protheus (leitura)
  - [services/protheusCobranca.js](services/protheusCobranca.js) — `POST /Cobranca/gerar-bordero` (Envio de Boleto)
  - [services/protheusSolicCompra.js](services/protheusSolicCompra.js) — `POST /SolicCompra/incluir` (Solicitar SC)
- **Endpoint padrão**: `POST {PROTHEUS_API_URL}/<recurso>/<acao>` — Basic Auth (`PROTHEUS_API_USER`/`PROTHEUS_API_PASS`, default `admin:Gn@tu5`)
- `.env`:
  - `PROTHEUS_API_URL=http://protheus.gnatus.com.br:8081/rest`
  - `PROTHEUS_API_USER=admin`
  - `PROTHEUS_API_PASS=Gn@tu5`
  - `PROTHEUS_API_PATH_BORDERO=/Cobranca/gerar-bordero` (override opcional)
  - `PROTHEUS_API_PATH_SOLIC_COMPRA=/SolicCompra/incluir` (override opcional)
- Timeout: 60s pra Cobrança · 180s pra SolicCompra (anexos inflam payload, AdvPL leva ~80s/MB)
- **AprovaCompras** (também custom Develsoft) é chamado direto do endpoint de Aprovações — não tem service-wrapper isolado

---

## 4½. Crons (scheduler)

[services/scheduler.js](services/scheduler.js) usa `node-schedule` e roda 3 jobs:

| Cron | Horário | Job | Descrição |
|---|---|---|---|
| `0 9 * * *` | 09:00 todo dia | `cobranca-whatsapp` | Dispara WhatsApp pra clientes em D-1, D0 e **D+1..D+3** (janela 1 a 3 dias de atraso). Verifica flag `automacao_ativa` em `tab_cobranca_whatsapp_config` |
| `30 8 * * *` | 08:30 todo dia | `contratos` | Cron de alertas D-90/D-60/D-30 do vencimento de contratos (e-mail pro responsável). Idempotente via UNIQUE em `tab_contrato_alerta` |
| `0 3 * * *` | 03:00 todo dia | `estoque-snapshot` | Refaz o snapshot do mês corrente em `tab_estoque_snapshot_mensal` + atualiza `tab_estoque_produto_meta` (lead time / unidade). Bootstrap inicial (12 meses) precisa ser manual: `node scripts/rodar-snapshot-estoque.js 12` |

Inicializado no `index.js` via `app.services.Scheduler.start(app)`.

Endpoints manuais pra rodar agora (debug/teste — perm 0):
- `POST /cobranca/whatsapp-disparar` — força disparo de cobrança WhatsApp
- `POST /contratos/alertas/disparar` — força cron de alertas de contrato

---

## 5. Deploy

### 5.1 Infra
- **VPS**: Hostinger KVM 4 (Boston/US), Ubuntu 24.04, IP `177.7.37.251`
- **Domínio**: `intranew.gnatus.com.br` via Cloudflare (registro A direto, não proxy)
- **SSL**: Let's Encrypt via certbot (auto-renew via systemd timer)
- **Web server**: Nginx 1.24 reverse proxy `/api/*` → `localhost:3000`, frontend estático em `/home/intranet/frontend/dist`
- **Process manager**: PM2 (`pm2 startup systemd` pra autostart) — process name `api` em cluster mode
- **Firewall**: UFW + perfil "Gnatus" no painel Hostinger (SSH 22, HTTP 80, HTTPS 443)

### 5.2 Pasta de produção
```
/home/intranet/
├── backend/   (git: api_gnatus_nodejs)
│   ├── .env
│   └── pm2.config.js
└── frontend/  (git: frontend_intranet_react)
    ├── .env.production  (VITE_API_URL, VITE_MS_*)
    └── dist/            (gerado por npm run build)
```

### 5.3 Deploy fluxo

**Backend** (Node, hot-reload manual):
```bash
sudo -u intranet git -C /home/intranet/backend pull
# Se tiver migration nova:
sudo -u postgres psql -U intranet -d intranet -f /home/intranet/backend/database/postgres/NN-xxx.sql
# Reload pm2 com env atualizado:
sudo -u intranet pm2 restart api --update-env
```

**Frontend** (rebuild estático):
```bash
sudo -u intranet git -C /home/intranet/frontend pull
cd /home/intranet/frontend
sudo -u intranet npm run build --legacy-peer-deps
# Nginx serve dist/ direto, não precisa restart
```

⚠️ Após qualquer mudança de frontend, fazer **Ctrl+Shift+R** no browser (force reload sem cache).

⚠️ Migrations precisam ser aplicadas como user `intranet`. Se aplicou como `postgres`, dar grants:
```sql
GRANT ALL PRIVILEGES ON tab_xxx TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_xxx_id_seq TO intranet;
```

### 5.4 Rede / FortiGate
- VPN IPsec site-to-site existe entre Gnatus FortiGate (200.15.18.119) e VPS (177.7.37.251), mas o **tráfego de aplicação usa NAT VIP** porque o FortiGate teve issues complexos com reply traffic via tunnel
- VIPs ativas:
  - **Protheus SQL Server**: `179.108.181.12:1433` → `192.168.1.140:1433` (Policy 62, source `VPS-Hostinger-Intranet`)
  - **AD LDAPS**: `200.15.18.119:36363` → `172.31.255.100:636` (Policy `VPS-to-AD-LDAPS`, mesma source)
- Mapeamento BU↔Equipe usa `SX5010 X5_TABELA = 'Z1'` (não 'ZA' como inicialmente)

---

## 6. Comandos úteis

### Backend local
```bash
cd .../api_ecopower_nodejs
node index.js              # iniciar (sem hot-reload)
npm start                  # idem
npm run dev                # com nodemon (hot-reload)
```

### PG local (Docker)
```bash
docker exec -i intranet-pg psql -U intranet -d intranet      # shell interativo
docker exec -i intranet-pg psql -U intranet -d intranet -f arquivo.sql  # rodar script
```

### Git
```bash
# Sempre commit nos 2 repos quando mexe nas duas pontas
cd .../api_ecopower_nodejs && git add . && git commit -m "..." && git push
cd .../frontend_intranet_react && git add . && git commit -m "..." && git push
```

### Verificar produção
```bash
# Backend
sudo -u intranet pm2 list
sudo -u intranet pm2 logs api --lines 30 --nostream
sudo -u intranet pm2 logs api --err --lines 30 --nostream  # só erros

# Nginx
sudo systemctl status nginx
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# DB
sudo -u postgres psql -d intranet -c "\dt"
```

### Scripts úteis ([scripts/](scripts/))
```bash
# Snapshot de estoque (bootstrap manual dos N meses) — depois eh automatico no cron 03:00
node scripts/rodar-snapshot-estoque.js 12

# Diagnostico de alcada de SC/PC: por que apareceu pra usuario X?
node scripts/debug-sc-alcada.js <numero> <usr_codigo>
# ex: node scripts/debug-sc-alcada.js 175950 000346

# Test bordero Protheus (10 cenarios — auth/validacoes/payload valido)
node scripts/test-cobranca-gerar-bordero.js
# Roda sem args usa http://protheus.gnatus.com.br:8081/rest/Cobranca/gerar-bordero
```

---

## 7. Convenções de código

- **SQL**: 100% parametrizado (`@param` no MSSQL, `$N` ou `@param` no PG via `services/pg.js`). Jamais concatenar strings.
- **Strings do Protheus**: sempre `RTRIM()` no SELECT (são padded com espaços).
- **Nomes de tabelas PG**: snake_case prefixo `tab_`. Ex: `tab_cobranca_atribuicao`.
- **Endpoints**: pasta = recurso, arquivo = ação. `cobranca/cobranca.dashboard.js` → `GET /cobranca/dashboard`.
- **Permissões**: array `perm: [N, 0]` em rota e sidebar, sempre os 2 lugares.
- **Commits**: mensagem clara em português, footer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **TypeScript**: build prod tem `noUnusedLocals` strict — não deixar imports/states unused.
- **Branch**: `master` em ambos repos. Sem feature branches no momento (deploy direto).

---

## 8. Pontos de atenção / armadilhas conhecidas

Ver [intranet_gotchas.md](file://../../.claude/.../memory/intranet_gotchas.md) na auto-memória.

Resumo dos principais:
- **`B1_CM1` não existe** na SB1 da Gnatus — usar `SB2.B2_CM1` agregado
- **`SX5 X5_TABELA = 'Z1'`** pra BUs (não 'ZA')
- **`E1_TIPO IN ('RA','NCC')`** sempre excluído nas queries de cobrança
- **`F2_VALPIS` / `F2_VALCOFI`** no SF2 da Gnatus (não `F2_PIS` / `F2_COFINS`)
- **`X3_OBRIGAT = 'x'`** minúsculo na Gnatus (não 'S' do padrão TOTVS) — afeta TRPWSIMP
- **MSAL precisa SPA platform** no Azure (não Web) — senão `AADSTS9002326`
- **Vite `VITE_*` é build-time** — precisa rebuild
- **PG migrations como user `intranet`** ou dar grants depois
- **Build frontend tem noUnusedLocals strict** — limpar imports não usados
- **CSS print** precisa força `visibility/opacity/color` em conteúdo do `.termo__doc`. Também esconder `.sidebar-mobile-toggle` / `.sidebar-mobile-close` / `.sidebar-backdrop`
- **VIP estática preserva source IP** — DC vê tráfego vindo do VPS público (177.7.37.251)
- **Vencido/saldo** usa `E1_VENCREA` (vencimento real) não `E1_VENCTO` (original) — porque negociações alteram
- **`E1_BAIXA` preenchida ≠ título quitado** — pode ser baixa parcial. Critério canônico de "em aberto" é `E1_SALDO > 0` apenas (não checar `E1_BAIXA`)
- **`E1_PORTADO` preenchido = banco já decidido pelo financeiro** — Envio de Boleto filtra justamente por isso
- **Recuperados conta no MÊS DA BAIXA** (não do vencimento) — visão operacional do time de cobrança. Título que venceu em dez e foi pago em mar entra no mês de mar (com `atraso_medio_dias = 83`). Decisão consciente: NÃO temos a visão por "safra" (vencimento), só a por "competência de caixa" (baixa)
- **View `faturamento_cfop` agrupa por (filial, doc, série, cfop)** — NFs com 2+ CFOPs duplicam em LEFT JOIN. Usar `EXISTS` em vez disso
- **Contratos: status calculado em runtime**, não gravado. Sempre depende de "hoje" — não cachear
- **Reajuste BCB: produto dos `(1+v/100)`**, não soma simples (juros compostos)
- **Anthropic: cuidado com prefixo `sk-ant-api03-` duplicado** ao colar no `.env`
- **OpenAI JSON mode** exige palavra "json" em alguma message
- **Repositórios em `digoferreira88/...`** (antigamente `gnatusintranet/...` — redirects funcionam mas evitar)
- **Cobrança WhatsApp via Fluig PHP** (`172.31.255.51`), não chamada direta no Gupshup. Endpoint correto é `POST /api/messages/send` (não `/api/messages`)
- **Aprovações: `tipoIntranet` e `justificativa`** nos calls de auditoria (não `tipo`/`observacao` — bug histórico já fixado)
- **Importer XLSX**: planilha do fiscal pode ter Date solta em coluna A — `trim()` defensivo deve retornar null pra Date (não `String(Date)` que vira string ICU enorme estourando varchar curto)
- **PG `psql -U intranet`** exige senha — passar `PGPASSWORD` do `.env` antes (peer auth do user `postgres` vs senha do `intranet`)
- **Aprovações de SC: alçada por grupo só vale se `CR_USER` estiver vazio** (2026-05-13). Se a SCR tem aprovador nomeado, só ele aprova — qualquer outro membro do grupo recebe 403 do Protheus ("não faz parte da alçada")
- **WhatsApp D+3 = janela 1 a 3 dias**, não "≥ 3 dias" (corrigido em 2026-05-12). `mode: 'janela'` no `services/scheduler.js TIPOS` com `delta=-3, deltaMax=-1`. Antes pegava títulos de 1000+ dias atrás
- **Estoque snapshot precisa GRANT explícito**: as tabelas criadas como `postgres` não dão permissão automática pro role `intranet`. Sempre rodar a migration via psql que inclui `GRANT SELECT/INSERT/UPDATE/DELETE ON ... TO intranet` (ver migrations 38/39/40 como exemplo). Sem isso o backend dá `permission denied for table`
- **Cobrança Borderô (Develsoft)**: validações 400/413 do stub funcionam mas o 401 vem com body genérico do AppServer (`{"message":"The request requires authentication..."}`) porque o `AccessControl` bloqueia ANTES da função AdvPL rodar. O test script aceita 401 só pelo status code, sem checar `codigo_erro`
- **SC criada via Intranet**: solicitante deve ser `USR_CODIGO` do Protheus (6 chars, login do SYS_USR), não email. Caminho: `req.user.CODIGO_PROTHEUS` (USR_ID) → `SELECT TOP 1 USR_CODIGO FROM SYS_USR WHERE USR_ID = @cod`. Antes mandávamos email (16+ chars), estourava C1_USER e AdvPL crashava com HTTP 500 genérico
- **SharePoint anexos > 4MB** requer upload session do Graph (não simples PUT). Não implementado em F1. Limite atual hardcoded em `MAX_SIMPLE_UPLOAD` no `services/graphFiles.js`
- **SharePoint via Application Permissions** não acessa OneDrive pessoal de forma confiável — destino tem que ser **Site SharePoint** dedicado (`/sites/Pipefy`). Permission `Files.ReadWrite.All` (ou `Sites.Selected` com grant restrito) precisa admin consent
- **Produção 12 etapas**: a etapa 3 (Liberação de Início de Processo) tem checklist hardcoded de 8 requisitos em `_etapas.js`. Aprovar a etapa sem completar checklist deveria ser bloqueado no frontend — confirmar regra antes de relaxar
- **Log de etapas começa limpo**: `tab_prod_registro_etapa_log` (migration 46) só recebe rows criadas a partir da instalação. Etapas existentes NÃO geram histórico retroativo. Cálculos de tempo médio nos primeiros dias podem estar enviesados pra baixo
- **Instruções de Trabalho**: editar instrução do produto X impacta TODAS as OPs (passadas e futuras) imediatamente — linkagem é dinâmica via `produto_codigo`. Manter versões anteriores não foi escopo da F1 (Pipefy também não tinha)
- **Retorno do banco**: Intranet NÃO parseia CNAB. Operador roda FINA130/140 no Protheus → atualiza SE1 → POST `/sincronizar` consulta. Códigos de ocorrência fora do `MAP_OCORRENCIA` viram `DESCONHECIDO` — quando aparecer, adicionar manualmente em `boleto-lote-sincronizar.js`
- **Lote de boleto não reenviável**: status `CRIADO` só vira `ENVIADO_PROTHEUS` 1 vez. Rejeições parciais ficam visíveis no `protheus_resposta.detalhes[]`, mas pra reenviar precisaria criar novo lote

---

## 9. Roadmap conhecido / pendências

### Cobrança
- Tela dedicada de gestão de carteira por cliente em lote (atualmente só individual no drawer do dashboard cobrança)
- Eficiência por ação (acordo cumprido vs total)
- Filtros temporais no Dashboard de Cobrança (hoje só mostra estado atual)

### Envio de Boleto
- ~~**Onda 2**: integração REST com Protheus pra gerar borderô~~ ✅ **Implementado em 2026-05-13** (migration 42 + `protheusCobranca.js`)
- ~~**Onda 3.1-3.3**: ler retorno do banco via SE1~~ ✅ **Implementado** (migration 44 + endpoint `/sincronizar`)
- **Onda 3.4-3.6 (pendente)**: disparar boleto por e-mail/WhatsApp a partir de `status_banco = 'REGISTRADO'`. Gerar PDF próprio do boleto (sem depender do ESF050)

### Liberação Financeira
- ~~**Onda 1**: tela que substitui planilha+dinâmica (carteira filtrada por estatus 20) + ações/observações por pedido~~ ✅ **Implementado em 2026-05-20** (migration 49)
- **Onda 2 (pendente)**: botão "Liberar no Protheus" — executar a sequência de liberação custom (rotina Develsoft ligada à `v_filapedidos` / SC9 `C9_BLCRED`). Precisa de **endpoint REST custom da Develsoft** (mesmo padrão do `AprovaCompras/aprovar`) + prints da sequência atual com a operadora. Provável: service `services/protheusLiberacao.js` + `POST /financeiro/liberacao/:pedido/liberar`

### Contratos
- **Onda 3**: assinatura digital (Clicksign API), faturamento automático (gerar SE1), renovação automática quando `renovacao_automatica = true`, alertas por WhatsApp (alongside e-mail)

### Apoio Gerencial / Apresentações
- Editor visual de slides (atualmente o operador pega o que a IA devolveu, sem permitir ajustes pontuais)
- Suporte a PDF/DOCX como input (hoje só XLSX/CSV)
- Templates corporativos (escolher tema antes da geração)

### Outros
- Notificações em tempo real (Socket.IO já carregado mas não usado)
- Assinatura digital nos termos (substituir o print)
- Adaptar `TermoEquipamento.tsx` pra ler query params auto-preenchendo formulário (atualmente só link)

---

## 10. Histórico de migrations (ordem de aplicação)

| # | Arquivo | O que faz |
|---|---------|-----------|
| 01 | `01-schema.sql` | Schema base (tab_intranet_usr, perms, cofre, etc.) |
| 02 | `02-migrate-data.js` | Migra dados MSSQL → PG (script JS conectando ambos) |
| 03 | `03-refactor-mssql-to-pg.js` | Validação pós-migração |
| 05 | `05-sac-pabx.sql` | Histórico PABX/ligações |
| 06 | `06-controladoria-poder-terceiros.sql` | Tabela poder de terceiros (controle operacional) |
| 07 | `07-tecnologia-provisionamento.sql` | Log de provisioning AD/M365 |
| 08 | `08-tecnologia-termo-equipamento.sql` | `tab_termo_equipamento` |
| 09 | `09-seed-permissoes-base.sql` | Seed de 27 permissões iniciais |
| 10 | `10-cobranca-atribuicao.sql` | `tab_cobranca_atribuicao` (carteira por cliente) |
| 11 | `11-cobranca-bu-equipe.sql` | `tab_cobranca_bu_equipe` + 64 mapeamentos seedados |
| 12 | `12-tecnologia-equipamento-atual.sql` | `tab_equipamento_atual` (estado de equips) |
| 13 | `13-compras-mcl.sql` | MCL — `tab_mcl_indice`, `tab_mcl_sc_snapshot` |
| 14 | `14-mcl-standard-cost.sql` | `tab_mcl_standard_cost` |
| 15 | `15-mcl-scii.sql` | `tab_mcl_scii` (SC Item Imobilizado) |
| 16 | `16-provisionamento-acao.sql` | `tab_provis_acao` (log granular de cada ação no AD/M365) |
| 17 | `17-producao-registro.sql` | `tab_producao_registro` |
| 18 | `18-producao-dashboard.sql` | Tabelas auxiliares pro dashboard de produção |
| 19 | `19-universidade.sql` | Trilhas/cursos/módulos/aulas |
| 20 | `20-universidade-quiz.sql` | Quiz no fim do módulo |
| 21 | `21-vendas-tes-categoria.sql` | Mapeamento TES → Categoria de Venda |
| 22 | `22-vendas-analitico.sql` | Tabelas de apoio pro Vendas Analítico |
| 23 | `23-universidade-fix-progresso.sql` | Corrige UNIQUE em `tab_uni_progresso` (user+aula) |
| 24 | `24-cobranca-anexo.sql` | `tab_cobranca_anexo` (PDF/imagens em ações) |
| 25 | `25-cobranca-whatsapp.sql` | `tab_cobranca_whatsapp_*` (config + envios + log) |
| 26 | `26-poder-terceiros-controle.sql` | `tab_pt_envio` + `tab_pt_envio_item` + `tab_pt_finalizacao` + `tab_pt_envio_acao` (substitui planilha do fiscal) |
| 27 | `27-tecnologia-protheus-import.sql` | `tab_protheus_import_log` (log de execuções TRPWSIMP) + perm 1031 |
| 28 | `28-protheus-import-layout.sql` | `tab_protheus_import_layout` (mapeamentos XLSX→Protheus salvos) |
| 29 | `29-tecnologia-auditoria.sql` | `tab_auditoria` + extensão `pg_trgm` + perm 1032 (Tecnologia - Auditoria) |
| 30 | `30-termo-dispositivo.sql` | `tab_termo_dispositivo` — 1 termo agora tem N dispositivos. Backfill automático |
| 31 | `31-telefonia-movel.sql` | `tab_operadora` (seed Claro/Tim/Vivo) + `tab_telefonia_*` (conta/departamento/linha/hist) |
| 32 | `32-apoio-gerencial.sql` | `tab_apoio_apresentacao` (apresentações geradas via IA) + perm 5001 |
| 33 | `33-pt-novas-colunas.sql` | Adiciona `atualizado_em_planilha` + `novo_vencimento_obs` em `tab_pt_envio` (layout 2026 da planilha) |
| 34 | `34-pt-pedido-venda-amplo.sql` | Amplia `pedido_venda` em `tab_pt_finalizacao` pra varchar(200) |
| 35 | `35-financeiro-envio-boleto.sql` | `tab_boleto_envio_lote` + `tab_boleto_envio_lote_titulo` + perm 8005 |
| 36 | `36-contratos.sql` | `tab_contrato` + `tab_contrato_aditivo` + `tab_contrato_anexo` + `tab_contrato_alerta` + perms 5002/5003/5004 |
| 37 | `37-telefonia-valor.sql` | Adiciona `valor_mensal numeric(10,2)` em `tab_telefonia_linha` (custo mensal das linhas) |
| 38 | `38-estoque-dashboards.sql` | `tab_estoque_snapshot_mensal` + `tab_estoque_parametros` (cache 12m + lead time/z/janela por tipo) + perm 11004 |
| 39 | `39-estoque-produto-meta.sql` | `tab_estoque_produto_meta` — cache de metadados B1 (descrição/tipo/grupo/UM/B1_PE). Atualizado pelo cron de snapshot |
| 40 | `40-cobranca-meta-perfil.sql` | `tab_cobranca_meta_perfil` (4 perfis seed) + coluna `perfil` em `tab_cobranca_bu_equipe` (classifica em Corp/Atacado/AT/Varejo) |
| 41 | `41-vendas-ranking-perm.sql` | Permissão 2005 — Ranking de Vendas por pedidos em aberto (distinto do 2001 por faturamento NF) |
| 42 | `42-boleto-bordero-protheus.sql` | Onda 2 do Envio de Boleto — adiciona em `tab_boleto_envio_lote`: `lote_protheus`, `enviado_em`, `enviado_por_email`, `qt_processados`, `qt_rejeitados`, `protheus_resposta` (jsonb da resposta REST) |
| 43 | `43-compras-solicitar.sql` | `tab_sc_intranet_log` (log de cada tentativa de criar SC via Intranet) + perm 4004 (Solicitar Compra). SC eh criada no Protheus via REST custom — esta tabela só guarda histórico |
| 44 | `44-boleto-retorno.sql` | Onda 3 do Envio de Boleto — `tab_boleto_envio_lote_retorno` (1 row por título com status do banco — REGISTRADO/LIQUIDADO/BAIXADO/REJEITADO/PENDENTE/DESCONHECIDO derivado de E1_OCORREN + E1_BAIXA). Adiciona contadores no lote (`sincronizado_em`, `qt_registrados/liquidados/rejeitados_banco/pendentes_banco`) |
| 45 | `45-producao-anexo-sharepoint.sql` | Estende `tab_prod_registro_anexo` com `origem` (`url_externa`/`sharepoint`) + `sharepoint_drive_id/item_id/path`, `nome_original`, `mime_type`, `tamanho_bytes`. Backfill marca anexos antigos como `url_externa` |
| 46 | `46-producao-gestao.sql` | `tab_prod_registro_etapa_log` — log de transições de status nas etapas (de→para, mudou_por, mudou_em). Popula via etapa-update. Permite calcular tempos médios e produtividade por colaborador. Sem perm nova (14002 já existe) |
| 47 | `47-producao-instrucoes.sql` | `tab_prod_instrucao` — catálogo central de Instruções de Trabalho (1 por produto+etapa, ou geral). Storage no SharePoint `/sites/Pipefy/Documents/Instrucoes Produto/{codigo}/`. Linkagem dinâmica: editar instrução impacta todas OPs imediatamente |
| 48 | `48-estoque-produto-meta-override.sql` | Estende `tab_estoque_produto_meta` com `lead_time_override`, `demanda_mensal_manual`, `estoque_seguranca_manual`, `observacao_manual`, `atualizado_por`, `manual_em`. Quando preenchido, ganha do cálculo automático no dashboard de Qualidade |
| 49 | `49-financeiro-liberacao.sql` | `tab_lib_financeira_anotacao` (ações/observações por pedido na Liberação Financeira) + perm 8006 |

⚠️ Migrations são **idempotentes** (`CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO NOTHING`). Pode rodar de novo sem quebrar.

⚠️ Novas migrations devem incrementar a numeração (próxima é #50) e seguir o padrão `NN-modulo-acao.sql`. Aplicar como user `intranet` (não `postgres`):

```bash
sudo -u intranet bash -c 'set -a; . /home/intranet/backend/.env; set +a; PGPASSWORD="$PG_PASSWORD" psql -h localhost -U intranet -d intranet -f /home/intranet/backend/database/postgres/NN-xxx.sql'
```

---

## 11. Catálogo de Permissões

> Catálogo consolidado de todas as permissões em uso. Seed base em [09-seed-permissoes-base.sql](database/postgres/09-seed-permissoes-base.sql); permissões novas são adicionadas inline em migrations subsequentes (ex: 27/29/31/32/35/36/41/43).

### Faixas de numeração
| Faixa | Módulo |
|---|---|
| `0` | Administrador (acesso total — passa por qualquer `Protect`) |
| `1xxx` | Tecnologia |
| `2xxx` | Faturamento / Vendas |
| `3xxx` | Planejamento |
| `4xxx` | Compras |
| `5xxx` | Apoio Gerencial / Perfil |
| `6xxx` | SAC |
| `7xxx` | Perfil (Cofre) |
| `8xxx` | Financeiro |
| `9xxx` | Cobrança |
| `10xxx` | Gerência |
| `11xxx` | Controladoria |
| `12xxx` | Expedição |
| `13xxx` | Compras (Aprovações) |
| `14xxx` | Produção |
| `15xxx` | Universidade |

### Permissões ativas

| Cód | Módulo | Descrição |
|---|---|---|
| 0    | Sistema       | Administrador (acesso total) |
| 1026 | Tecnologia    | Gerenciamento de Permissões |
| 1027 | Tecnologia    | Termo de Responsabilidade / Equipamentos / Telefonia Móvel |
| 1028 | Tecnologia    | Gestão de Usuários |
| 1029 | Tecnologia    | Provisionamento de Usuários (AD/M365) |
| 1030 | Tecnologia    | Cobrança WhatsApp (automação) |
| 1031 | Tecnologia    | Importação Protheus (TRPWSIMP) — migration 27 |
| 1032 | Tecnologia    | Auditoria (logs centralizados) — migration 29 |
| 2001 | Faturamento   | Ranking de Vendedores (por NF) |
| 2002 | Faturamento   | Relatório de Faturamento |
| 2003 | Faturamento   | Vendas Analítico / Saídas Diversas |
| 2004 | Faturamento   | Curva ABC / Carteira / Itens sem Movimento / Histórico Anual |
| 2005 | Faturamento   | Ranking de Vendas (pedidos em aberto) — migration 41 |
| 3001 | Planejamento  | Disponibilidade |
| 4001 | Compras       | Solicitações de Compra |
| 4002 | Compras       | Pedidos de Compra |
| 4003 | Compras       | MCL (Compras Mínimas Lucrativas) |
| 4004 | Compras       | Solicitar Compra (criar SC via Intranet) — migration 43 |
| 5001 | Apoio Ger.    | Reserva de Sala / Gerador de Apresentações (IA) |
| 5002 | Apoio Ger.    | Contratos - Ver — migration 36 |
| 5003 | Apoio Ger.    | Contratos - Editar — migration 36 |
| 5004 | Apoio Ger.    | Contratos - Aprovar Aditivos — migration 36 |
| 6001 | SAC           | Consulta de Cliente |
| 6002 | SAC           | Supervisão |
| 7001 | Perfil        | Cofre de Senhas |
| 8001 | Financeiro    | Contas a Pagar |
| 8002 | Financeiro    | Contas a Receber |
| 8004 | Financeiro    | Fluxo de Caixa |
| 8005 | Financeiro    | Envio de Boleto (curadoria + bordero) — migration 35 |
| 8006 | Financeiro    | Liberação Financeira — migration 49 |
| 9001 | Cobrança      | Painel / Dashboard / BU-Equipe / Faturamento vs Inadimplência / Equipes Ranking / Meta Perfil |
| 9003 | Cobrança      | Minhas Ações |
| 9004 | Cobrança      | Envio WhatsApp (curadoria operador) |
| 10001 | Gerência     | DRE Gerencial |
| 11001 | Controladoria| Estoque (lista simples) |
| 11002 | Controladoria| Custo de Produto |
| 11003 | Controladoria| Poder de Terceiros |
| 11004 | Controladoria| Estoque Dashboards (Valor / Qualidade / Tendência / Parâmetros Manuais) — migration 38 |
| 12001 | Expedição    | Notas a Expedir |
| 12002 | Expedição    | Borderô de Etiquetagem |
| 13001 | Compras      | Aprovador (SC/PC) |
| 14001 | Produção     | Registro (operador) |
| 14002 | Produção     | Admin / Gestão / Instruções |
| 14003 | Produção     | Dashboard (visualização apenas) |
| 15001 | Universidade | Aluno |
| 15002 | Universidade | Instrutor |
| 15003 | Universidade | Admin |

⚠️ Permissões `[]` (array vazio) = qualquer usuário logado (Dashboard, Alterar Senha)
⚠️ Padrão de uso: `requiredPerms={[N, 0]}` no `<Protect>` — usuário com perm N OU admin (0) passa
