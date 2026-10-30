# ADR-001 — Arquitetura do módulo de Qualificação de Fornecedores

- **Status:** aceito (implementado em 22/10/2026; **realinhado ao PRO 7.3.7 REV OUT261 em 30/10/2026**; ainda não publicado em produção)
- **Escopo:** PRO 7.3.7 REV OUT261 · FORM 7.3.21 REV OUT26 · FORM 7.3.22/23 · FORM 7.3.24 · FORM 7.3.28 · FORM 7.4.3.H · ISO 13485:2016 req. 4.2.4 e 7.4 · RDC 665/2022 art. 28–37
- **Decisões da Qualidade/Engenharia (30/10/2026):** ver `PONTOS-ABERTOS.md`, Parte 1.
- **Onde está:** migration `database/postgres/133-qualificacao-fornecedores.sql`; serviços `services/qfRegras.js` (fórmulas puras), `qfCore.js`, `qfImport.js`, `qfProcesso.js`, `qfInspecao.js`, `qfFicha.js`, `qfAlertas.js`; rotas `resources/qualificacao/*` (56 endpoints, ver `openapi.yaml`); tela `frontend_intranet_react/src/pages/QualificacaoFornecedores/`.
- **Stack:** a mesma da intranet — Node/Express + PostgreSQL 16, leitura do Protheus por SQL (mssql), React + Vite. Nenhuma dependência nova.

Cada seção abaixo é uma decisão: contexto → decisão → consequências.

---

## 1. Fornecedor identificado pelo código do Protheus (A2_COD), com código provisório

**Contexto.** A FORM 7.3.24 é, na prática, um extrato da SA2 com colunas de qualificação; as inspeções citam o código de 6 dígitos (ex.: 003794). Mas a qualificação pode começar **antes** de o fornecedor existir no ERP.

**Decisão.** `tab_qf_fornecedor.codigo` (único, 6 caracteres) = `A2_COD`. Fornecedor ainda não cadastrado no ERP recebe código provisório `Pnnnnn`, trocado pelo A2_COD na edição quando o ERP cadastrar (as inspeções acompanham). Códigos da planilha sem zeros à esquerda ("1365") são normalizados ("001365"). Lojas múltiplas da SA2 são tratadas como um fornecedor (a planilha também era por código).

**Consequências.** Um vínculo simples com qualquer consulta do ERP (pedido, NF). O provisório evita cadastro "fantasma" no Protheus só para qualificar.

## 2. Cadastro do Protheus é só lido; o módulo guarda um retrato

**Contexto.** A intranet trata o Protheus como somente leitura (exceções documentadas: reserva, borderô, previsão do PC). Bloquear pedido de fornecedor suspenso exigiria escrever no ERP.

**Decisão.** O módulo **nunca escreve no Protheus**. Guarda um retrato (razão, fantasia, CNPJ, UF, cidade, contato, bloqueio `A2_MSBLQL`) atualizado por "Sincronizar" (um fornecedor) ou "Sincronizar com o Protheus" (todos; inclui os que faltam como Não crítico). Contato preenchido no módulo não é apagado por um vazio do ERP. Pré-preenchimento da inspeção lê SC7 (pedido, item, C7_DATPRF), SD1/SF1 (NF/pré-nota) e SB1.

**Consequências.** Suspensão é um status da intranet: **não bloqueia pedido no ERP** (ponto aberto nº 7/10). A integração possível hoje é de leitura: `GET /qualificacao/status/{codigo}` responde se o fornecedor está apto.

## 3. Regras de cálculo como JSON versionado e imutável

**Contexto.** O PRO 7.3.7 pode ser revisado e **diverge da planilha em uso na tabela de P** (PRO: D-1/D+3/D+10/D+15/D+20; planilha: D-1/D+1/D+3/D+5/D+7). A especificação pede regras configuráveis com histórico.

**Decisão.** Faixas de C, P, N, classes A–E (limite, rótulo, cor, ação), pontuação do questionário, janela/escopo do N e tabela de amostragem NBR 5426 ficam em `tab_qf_regra_versao.conteudo` (JSONB). **Uma versão ativa** (índice único parcial). O conteúdo é **imutável** (trigger `tg_qf_regra_imutavel`): mudar uma faixa = criar outra versão. Cada inspeção grava `regra_versao_id`. Seed com duas versões: **"PRO 7.3.7 REV OUT261" (ativa)** e "FORM 7.4.3.H REV OUT25 (planilha — histórico)". O OUT261 tem **três tabelas de P** em `prazo`: `nacional` (dias de atraso na **entrega**), `importado` (dias de atraso na **coleta**) e `antecipacao` (dias antes, vale para os dois); o fornecedor importado (`nacional = false`) é medido pela coleta e a inspeção grava `tipo_prazo` (ENTREGA/COLETA). IQF máximo = 10. Lacunas do OUT261 completadas e descritas na própria versão: importado acima de 15 dias = 0,6; faixas de N mantidas da planilha. A versão também guarda `requalificacao` (12 meses) e `auditoriaAcompanhamento` (5.6.2).

**Consequências.** Trocar a tabela de P é um clique na Configuração (com motivo), sem código. Ao ativar uma versão, a classe de todos os fornecedores é recalculada; inspeções já lançadas mantêm os índices da versão delas. `qfRegras.validarRegra` impede versão incompleta.

## 4. Fórmulas puras e testadas, uma única implementação

**Decisão.** `services/qfRegras.js` não toca banco: C, P, N, IQF, classe, média, amostragem, pontuação e validação do questionário, documentos exigidos/checklist e validação da inspeção. A tela **pede o cálculo ao backend** (`POST /inspecoes/calcular`) em vez de repetir a conta em TypeScript. Testes em `test/qfRegras.test.js` (20 casos, `npm test`) leem as tabelas do próprio seed da migration — inclusive o caso INFITEK (14 inspeções → 10,2857 → A).

**Consequências.** Uma regra, um lugar. Fronteiras de faixa (79,9%, D+3/D+4, 8,9999) estão cobertas por teste.

## 5. IQF materializado no fornecedor

**Contexto.** ~3.300 fornecedores × ~6.500 inspeções (crescendo); a planilha usava SOMASE/CONT.SE em tempo real.

**Decisão.** `iqf_medio`, `qtd_inspecoes`, `classificacao` e `ultima_inspecao` ficam em `tab_qf_fornecedor` e são recalculados (`qfCore.recalcularFornecedor`) a cada inclusão, alteração ou exclusão de inspeção. Média simples das inspeções não excluídas com IQF (= fórmula da FORM 7.3.24). **Só fornecedor crítico recebe classe** (decisão 30/10: não crítico fica fora do monitoramento, mas o recebimento continua registrado). Fornecedor reprovado que volta por nova qualificação ganha `iqf_desde` = data da reaprovação: a média recomeça ali (o histórico continua visível) — senão o histórico que o reprovou o reprovaria de novo no primeiro recebimento. Mudança de classe vai para a trilha.

**Consequências.** Lista e dashboard sem agregação em tempo real. A tela também mostra o IQF dos últimos 12 meses (informativo — a classe oficial segue a média de todo o histórico, como a especificação define).

## 6. N calculado pelas entregas anteriores; ajuste manual só da Qualidade

**Decisão.** N = NCs nas `janelaN` (3) inspeções **anteriores** do fornecedor (por data e depois nº do relatório), sem contar a atual — é o comportamento observado na planilha. NC = peça reprovada **ou** RNC preenchido. Escopo **fornecedor + item** (decisão 30/10, o menos punitivo; item comparado sem zeros à esquerda); a regra antiga da planilha usava por fornecedor. Ajuste manual de C, P ou N: só Qualidade, com justificativa, e só para um valor que exista na tabela vigente; fica marcado (`*_manual`) e na trilha.

**Consequências.** O histórico tem N < 1 sem peça reprovada: a Qualidade considerou **provável erro de preenchimento** — a importação marca essas linhas com aviso (141). O ajuste manual continua disponível. O N gravado reflete o que se sabia na data; não é recalculado retroativamente se uma inspeção antiga mudar.

## 7. Histórico importado como está, com avisos por linha

**Contexto.** A planilha tem 6.467 linhas com dados (13.139 pré-numeradas): "Qtd. Insp." é fórmula de amostragem (672 linhas com aprovada+reprovada ≠ inspecionada; 605 vazias, a maioria lotes de 1 peça), 18 datas no futuro, 6 sem data, 2 linhas com fornecedor "CQ/01".

**Decisão.** `qfImport` grava **C, P, N e IQF como os inspetores registraram** (não recalcula), aponta a versão "planilha", e grava cada anomalia em `legado_avisos` (e no relatório). Nada é corrigido em silêncio. Reimportar é idempotente: insere o que falta e só atualiza linha que veio da planilha e **não foi editada no módulo** (`atualizado_por IS NULL`). Fornecedor citado nas inspeções e ausente da 7.3.24 é criado como Não crítico com aviso. Relatório confere banco × planilha (SOMASE/CONT.SE por código).

**Consequências.** Resultado no ensaio local: 3.305 fornecedores (46 críticos), 6.465 inspeções, 238 fornecedores com inspeção, **0 divergências**, INFITEK 14 → 10,2857 → A. Corrigir os dados herdados é trabalho da Qualidade na tela (com trilha).

## 8. Alterar registro herdado: erro antigo não bloqueia, erro novo bloqueia; P e N herdados

**Decisão.** Ao alterar uma inspeção, as validações rodam no estado anterior e no novo; só **erros novos** bloqueiam (ex.: corrigir a data de um legado não exige consertar quantidades que já vinham erradas). Só se recalcula se mudou campo do cálculo. Em registro da planilha, ao recalcular, **P** (sem datas de entrega) e **N** (pode ter NC externa) originais são mantidos como ajuste com justificativa automática; só o C é refeito (`qfInspecao.herdarDoLegado`, usado também na prévia).

**Consequências.** Correções pontuais ficam possíveis sem inventar dado. Alteração exige motivo; inspetor só altera as próprias.

## 9. Nada se apaga; trilha somente-inclusão

**Decisão.** Exclusão é lógica em inspeções, documentos (SUBSTITUIDO/EXCLUIDO) e anexos, sempre com motivo. `tab_qf_log` guarda campo a campo (antes/depois, motivo, usuário, IP) e é **append-only**: trigger bloqueia UPDATE/DELETE e o role da aplicação só tem `SELECT, INSERT`. Eventos sensíveis (suspensão, exclusão, aprovação final) também vão para a `tab_auditoria` geral da intranet.

**Consequências.** Atende à exigência de rastreabilidade (RDC 665). A retenção por 10 anos é política de banco/backup — não há expurgo no módulo.

## 10. Assinatura eletrônica na aprovação final

**Decisão.** A aprovação do gerente de engenharia (última etapa; vale como aprovação do FORM 7.3.21 na qualificação e do FORM 7.3.28 na requalificação) exige **reconfirmar a senha da intranet** (bcrypt, mesma do login), uma declaração de significado e grava quem, quando, IP e o **SHA-256 do estado aprovado** (processo, ficha, avaliações, auditorias, situação dos documentos). Senha errada não grava e fica na trilha (`ASSINATURA_RECUSADA`).

**Consequências.** Assinatura atribuível e verificável sem certificado digital. Usuário que só entra por SSO sem senha local não consegue assinar (hoje o login da intranet é por senha).

## 11. Andamento do wizard derivado dos dados

**Decisão.** Dois fluxos — qualificação (CADASTRO, CRITICIDADE, DOCUMENTOS, QUESTIONARIO, ANALISE, AUDITORIA, AMOSTRA, AVALIACAO, APROVACAO) e requalificação anual (FORM_7328, DOCUMENTAL, DESEMPENHO, ALTERACOES e, se a análise das alterações pedir, QUESTIONARIO/AUDITORIA/AMOSTRA/AVALIACAO, APROVACAO). As etapas não têm "marcar como feito": `qfProcesso.progresso()` calcula cada uma (ok / pendente / aguardando / não se aplica / falhou / opcional) a partir do que existe (criticidade confirmada, checklist de documentos, ficha, auditoria, amostra, avaliações). **A mesma função** decide os resultados permitidos na aprovação — o endpoint recusa (409) com os bloqueios. Não crítico pula documentos/questionário/auditoria; amostra pode ser dispensada com justificativa (ex.: serviço de calibração); auditoria é decidida pela **Engenharia**, sempre com justificativa (PRO 4.1 e Nota do 5.6), com a sugestão do 5.6.1 na tela (crítico B, ou A sem ISO). Na requalificação o resultado é sugerido pelos critérios do PRO 5.10.2 (`qfRegras.avaliarRequalificacao`) e a tela só permite o sugerido ou pior. Um processo aberto por fornecedor (índice único parcial); tipos INICIAL, REQUALIFICACAO, REATIVACAO.

**Consequências.** Barra de progresso e bloqueio nunca divergem. Questionário < 50% encerra a qualificação e marca REPROVADO.

## 12. Questionário público por link com token

**Decisão.** O fornecedor responde o FORM 7.3.21 (e o 7.3.28 na requalificação) **sem login**, por link com token de 48 hex (aleatório), validade configurável (30 dias) e limite por IP (150 leituras / 20 envios / 60 anexos a cada 15 min). O FORM 7.3.21 REV OUT26 vem inteiro: dados cadastrais, até 3 contatos, **documentação do fornecedor com upload** (`POST /publico/ficha/{token}/anexo`, PDF/imagem ≤ 10 MB, preso à ficha até a Engenharia conferir e registrar como documento) e as **36 perguntas oficiais** com a orientação de cada uma. Pergunta em branco = NÃO (observação do FORM); comprovação obrigatória em SIM/PARCIAL; % por seção. O envio exige o **aceite da declaração** (assinatura eletrônica do fornecedor). Cada resposta guarda o texto da pergunta da época, e a ficha guarda o texto da declaração aceita com SHA-256, data e IP. A Qualidade pode transcrever ficha recebida em papel/PDF e devolver com motivo (link renovado). O link só é exibido a Engenharia+ (responde em nome do fornecedor).

**Consequências.** Mesmo padrão da inscrição pública de Treinamentos e da pesquisa NPS. A avaliação crítica do questionário é da **Qualidade**; o FORM 7.3.28 vai para a análise da Engenharia.

## 13. Notificações idempotentes; e-mail externo desligado

**Decisão.** Todo aviso passa por `tab_qf_notificacao` com `chave` única (não repete o mesmo aviso). Destinatários internos vêm da Configuração; sem destinatário o aviso fica **registrado como retido**. E-mail ao **fornecedor** só sai com `email_fornecedor = true` (padrão **false**): desligado, a tela devolve o texto para a Qualidade enviar. Em ambiente que não é produção, o `emailService` só registra no log.

**Consequências.** Nada sai para fora da empresa antes de a Qualidade aprovar os textos.

## 14. Ações automáticas por classe e jobs diários, com chave

**Decisão (PRO 5.9 + decisão de 30/10).** Ao **piorar** de classe após uma inspeção (`acoes_automaticas`, padrão ligado), só para fornecedor crítico:
- **C** → suspenso tipo `PLANO_ACAO_C`: recebimento bloqueado até a Engenharia registrar o plano de ação (texto + anexo); liberado, volta a amostragem;
- **D** → idem (`PLANO_ACAO_D`) e `inspecao_100`: depois do plano, só recebe com o lote inteiro inspecionado, até sair da D;
- **E** (IQF < 5) → **reprovado e inativado**; volta só por nova qualificação.

Piorar exige um **novo** plano (o anterior fica na trilha); melhorar não libera bloqueio sozinho. O bloqueio por plano é **absoluto** — nem a Qualidade lança recebimento; os demais bloqueios (inativo, suspenso por documento/requalificação, não aprovado) deixam só a Qualidade receber, com justificativa gravada na inspeção.

O job diário `qfAlertas` (07:10 de Brasília; cron em UTC) avisa documento vencendo (30 e 1 dia) e, vencido um obrigatório ou o prazo de um protocolo, suspende (`suspender_doc_vencido`); avisa requalificação a 60 e 30 dias e, vencida, suspende (`suspender_requalificacao_vencida`). Fica **dormente sem `QF_ALERTAS_ATIVO=1`**. A importação não dispara ações.

**Consequências.** Um fornecedor com poucas inspeções pode cair para C/D com um único lote ruim (testado: 10 + 3 → média 6,5 → D → bloqueado). Por isso a chave existe e o tema está nas pendências.

## 15. Permissões hierárquicas 23001–23006

**Decisão.** 23001 consulta · 23002 inspetor · 23003 engenharia · 23004 qualidade · 23005 gerente de engenharia · 23006 administração; cada nível inclui os anteriores (perm 0 = admin universal). O middleware `requirePerm` recebe a lista do nível (`qfCore.NIVEL`); regras finas (inspetor só altera as próprias, ajuste manual, DISPENSADO, nº manual do relatório) ficam no serviço. As permissões entram no catálogo `tab_intranet_permissoes` (módulo "Qualidade") para aparecerem na tela de permissões.

## 16. Cores das classes validadas para daltonismo; letra sempre escrita

**Decisão.** A–E mantêm a semântica do procedimento (verde escuro → vermelho), em passos validados com o validador de paleta (separação para protanopia/deuteranopia e visão normal entre classes vizinhas): **A `#13753a`, B `#55a83a`, C `#efb300`, D `#9c1c8c`, E `#d84315`**. O amarelo de C fica claro por necessidade, então a classe **nunca aparece só pela cor**: pílula com a letra em tinta de texto, rótulo ao lado, tabela disponível. As cores também ficam no JSON da regra (editáveis por versão).

## 17. Desempenho

**Decisão.** Paginação no servidor em fornecedores e inspeções (≤ 200 por página); índices em `tab_qf_inspecao (fornecedor_id, data_inspecao DESC, rel_insp DESC)`, data, PC, NF e item; IQF materializado; situação de documentos calculada só para os críticos (dezenas) em JS — fonte única para lista, painel e job. Exportação limitada a 50 mil linhas. Anexos em BYTEA (padrão da intranet, ≤ 25 MB por arquivo, SHA-256 gravado).

## 18. Número do relatório contínuo

**Decisão.** `rel_insp` segue a numeração contínua da planilha (14751 … 21223 no histórico); o próximo é `MAX + 1`, com repetição em caso de colisão concorrente (índice único). Informar outro número é só da Administração.

**Consequências.** Decisão de 30/10: numeração **sequencial** mantida. Se um dia mudar para anual, muda-se a geração sem migrar dados.

## 19. Criticidade é do item; o fornecedor tem o conjunto

**Contexto.** OUT261 item 5.2: A (lista de componentes/serviços críticos — matérias-primas), B (dispositivo médico com notificação/registro), C (dispositivo sem registro), D (serviço crítico de terceiro). Decisão de 30/10: "o fornecedor é qualificado pela criticidade do item que fornece; existe plano de qualificação por criticidade".

**Decisão.** `tab_qf_item_critico` (código do item → A/B/C/D, chave sem zeros à esquerda) mantida pela Engenharia. `tab_qf_fornecedor.criticidades` é um **array** (vazio = não crítico). Documentos exigidos: a regra mais forte entre as criticidades do fornecedor (matriz `regra_a..regra_d` do FORM 7.3.21); perguntas por `aplicavel_a`. A ficha sugere as criticidades pelos itens das NFs de entrada (SD1, 24 meses) × lista; o recebimento de item crítico de fornecedor não qualificado naquela criticidade avisa a Engenharia.

**Consequências.** A lista de itens críticos precisa ser cadastrada antes do go-live; até lá nenhum item é reconhecido como crítico no recebimento.

## 20. Requalificação anual

**Decisão.** Aprovação de fornecedor crítico grava `qualificacao_valida_ate` = hoje + 12 meses (PRO 5.10). Requalificação é um processo próprio com o FORM 7.3.28 (atualização cadastral, documentos vencidos/vencendo, alterações declaradas, aceite) e análises documental, de desempenho (retrato do IQF/NCs/RNCs de 12 meses) e das alterações, cada uma com parecer. Resultado REQUALIFICADO / COM RESTRIÇÃO (exige plano + prazo) / NÃO REQUALIFICADO (suspende). Aprovar levanta suspensão por documento ou requalificação — salvo se o fornecedor está em C/D sem plano (aí vira bloqueio por plano).

**Consequências.** Os 46 críticos do legado não têm data de aprovação: aparecem como "requalificação sem data" e não são suspensos pelo job até receberem data ou passarem por requalificação.

## 21. ERP: avisos em vez de integração

**Decisão (30/10).** Sem integração por enquanto. Todo bloqueio gera e-mail "[Bloquear no Protheus]" (inativar o fornecedor na SA2) e toda liberação "[Liberar no Protheus]", para a Engenharia e a Qualidade, pelo mesmo mecanismo idempotente de notificações.

**Consequências.** Depende dos e-mails da Engenharia configurados; sem eles o aviso fica só registrado no módulo.
