# Manual do usuário — Qualificação de Fornecedores

Menu **Qualidade → Qualificação de Fornecedores** (endereço `/qualificacao-fornecedores`).

Base: **PRO 7.3.7 — Qualificação de Fornecedor, REV OUT261**.

O módulo substitui as planilhas:
- **FORM 7.3.24** — Lista de Qualificação de Fornecedores (Monitoramento);
- **FORM 7.4.3.H** — Relatório de Inspeção de Recebimento.

E conduz os formulários:
- **FORM 7.3.21** — Cadastro e Avaliação de Fornecedores;
- **FORM 7.3.22 / 7.3.23** — avaliação dimensional / funcional da amostra;
- **FORM 7.3.28** — Requalificação de Fornecedores.

A tela tem cinco abas:

| Aba | Para quê | Quem vê |
|---|---|---|
| **Qualificação** | Lista de fornecedores (FORM 7.3.24), ficha de cada fornecedor e controle de documentos | todos |
| **Recebimento** | Relatórios de inspeção de recebimento (FORM 7.4.3.H): lançar, consultar, exportar, imprimir | todos |
| **Dashboard** | Visão de gestão: classes, bloqueios, requalificação, documentos, inspeções do mês | todos |
| **Itens críticos** | Lista de componentes e serviços críticos (código do item → A, B, C ou D) | todos; só a Engenharia altera |
| **Configuração** | Regras de cálculo, documentos exigidos, requisitos do FORM 7.3.21, notificações, importação, trilha geral, permissões | Qualidade para cima; só a Administração altera |

A ficha de um fornecedor e a de uma inspeção abrem por cima de qualquer aba e têm endereço próprio: dá para copiar o endereço do navegador e mandar a um colega.

---

## 1. Conceitos

### IQF — Índice de Qualificação do Fornecedor

**IQF = C × P × N**, calculado em cada entrega inspecionada. Vai de **0 a 10**.

**C — conformidade do lote** (quanto do inspecionado foi aprovado):

| Conformes | C |
|---|---|
| 100% | 10 |
| 80% a 99,9% | 8 |
| 70% a 79,9% | 5 |
| 60% a 69,9% | 3 |
| abaixo de 60% | 0 |

**P — prazo.** Dias = data real − data prevista.
- **Fornecedor nacional:** mede a **entrega**.
- **Fornecedor importado:** mede a **coleta**.

| Atraso (nacional — entrega) | P | Atraso (importado — coleta) | P |
|---|---|---|---|
| no prazo até 2 dias | 1,0 | no prazo até 5 dias | 1,0 |
| 3 dias | 0,95 | 6 a 7 dias | 0,9 |
| 4 a 5 dias | 0,9 | 8 a 10 dias | 0,8 |
| 6 a 7 dias | 0,85 | 11 a 15 dias | 0,6 |
| 8 a 10 dias | 0,8 | mais de 15 dias | 0,6 ¹ |
| 11 a 15 dias | 0,7 | | |
| mais de 15 dias | 0,6 | | |

**Entrega/coleta antecipada** (vale para nacional e importado):

| Antecipação | P |
|---|---|
| 0 a 2 dias | 1,0 |
| 3 a 5 dias | 0,9 |
| 6 a 10 dias | 0,8 |
| 11 a 15 dias | 0,7 |
| mais de 15 dias | 0,5 |

¹ O PRO não define essa faixa; foi usado 0,6 (a confirmar com a Qualidade).

**N — não conformidades acumuladas.** Quantas das **3 entregas anteriores do mesmo item, do mesmo fornecedor**, tiveram NC. A entrega atual não conta.

| NCs nas 3 anteriores | N |
|---|---|
| 0 | 1,0 |
| 1 | 0,9 |
| 2 | 0,8 |
| 3 | 0,7 |

Uma entrega é "com NC" quando reprovou alguma peça **ou** tem número de RNC.

### Classe do fornecedor

**IQF médio** = média de todas as inspeções do fornecedor. Ele define a classe. **Só fornecedor crítico tem classe.**

| Classe | IQF médio | O que o sistema faz |
|---|---|---|
| **A** | 9 ou mais | Aprovado — ótimo desempenho |
| **B** | 8 a 8,99 | Aprovado — bom desempenho |
| **C** | 7 a 7,99 | **Bloqueia o recebimento** até a Engenharia registrar o plano de ação do fornecedor. Depois, volta a receber por amostragem. |
| **D** | 5 a 6,99 | **Bloqueia o recebimento** até o plano de ação. Depois, recebe **só com inspeção de 100% do lote**, até sair da classe D. |
| **E** | abaixo de 5 | **Reprova e inativa** o fornecedor. Ele volta só por uma nova qualificação completa. |

- O bloqueio por plano de ação vale para todos: **nem a Qualidade** consegue lançar recebimento.
- Melhorar de classe **não** libera um bloqueio sozinho. Piorar exige um **novo** plano.
- Quando um fornecedor reprovado é aprovado de novo, **a média do IQF recomeça** a partir da data da reaprovação. As inspeções antigas continuam visíveis, mas fora da média.
- A classe aparece sempre com a **letra escrita** ao lado da cor.

### Criticidade

**A criticidade é do item**; o fornecedor é qualificado pela criticidade dos itens que fornece (PRO 7.3.7 item 5.2):

| Criticidade | O que é | Onde se aplica |
|---|---|---|
| **Crítico A** | Item da lista de componentes e serviços críticos | Matérias-primas |
| **Crítico B** | Dispositivo médico passível de notificação ou registro na ANVISA | Produtos acabados e de revenda |
| **Crítico C** | Dispositivo médico **não** passível de notificação ou registro | Produtos acabados e de revenda |
| **Crítico D** | Serviço crítico de terceiro com impacto no produto (calibração, laudos radiométricos, processos especiais…) | Serviços |

- O fornecedor pode ter **mais de uma** criticidade (ex.: A + B). Os documentos exigidos seguem a regra mais forte entre elas.
- **Nenhuma criticidade = não crítico** (porcas, parafusos, chapas, fios, componentes eletrônicos…):
  - não exige qualificação prévia;
  - **não entra no monitoramento** do IQF (fica sem classe, fora dos rankings e das ações automáticas);
  - **o recebimento continua sendo registrado** normalmente.
- A **Lista de Itens Críticos** (aba Itens críticos) é a base de tudo: dela vêm a sugestão de criticidade na ficha e o alerta de item crítico no recebimento.

### Status do fornecedor

Em qualificação · Aprovado · Aprovado com restrição · Reprovado · Suspenso.

O **Suspenso** mostra o motivo:

| Motivo da suspensão | Como libera |
|---|---|
| Classe C ou D — aguardando plano de ação | A Engenharia registra o plano de ação |
| Documento vencido | Regularizar o documento e reativar |
| Requalificação vencida | Aprovar a requalificação (FORM 7.3.28) |
| Suspensão manual | Reativar |

**Inativo** é outra coisa: some das listas, do monitoramento e do recebimento, sem mudar o status.

### Avisos para o Protheus

O módulo **não bloqueia nada no Protheus** sozinho. Cada bloqueio gera um e-mail à Engenharia e à Qualidade:
- **"[Bloquear no Protheus]"** — por classe C/D/E, documento vencido, requalificação vencida ou suspensão manual. A Engenharia **inativa o fornecedor na SA2** manualmente.
- **"[Liberar no Protheus]"** — quando o fornecedor é liberado. A Engenharia **reativa na SA2**.

Os e-mails da Engenharia e da Qualidade precisam estar preenchidos em Configuração → Notificações. Sem eles, o aviso fica só registrado no módulo.

---

## 2. Perfis

Cada perfil faz tudo o que os anteriores fazem. A permissão é concedida pela TI em **Tecnologia → Gerenciamento de Permissões**, módulo **Qualidade**.

| Permissão | Perfil | Em resumo |
|---|---|---|
| 23001 | Consulta | vê tudo, não altera nada |
| 23002 | Inspetor | lança e corrige as próprias inspeções de recebimento |
| 23003 | Engenharia | conduz a qualificação e a requalificação, criticidade, itens críticos, documentos, plano de ação, suspende/reativa/inativa |
| 23004 | Garantia da Qualidade | analisa o FORM 7.3.21, audita, recebe de fornecedor bloqueado com justificativa, ajusta índices, corrige qualquer inspeção |
| 23005 | Gerente de Engenharia | assina a qualificação e a requalificação |
| 23006 | Administração | regras de cálculo, documentos exigidos, requisitos do FORM 7.3.21, configuração, importação |

---

## 3. Consulta (23001)

- **Lista de fornecedores** (aba **Qualificação → Lista de fornecedores (FORM 7.3.24)**).
  - Abre em **Críticos (monitoramento)**. Mude em **Criticidade** para Não crítico, Todos ou uma letra.
  - Outros filtros: Status, Classe (IQF), **Requalificação** (Vencida / Vence em 60 dias / Sem data), Tipo, Cadastro (Ativos / Inativos / Todos).
  - Os botões de **Atenção** mostram os casos que pedem ação: Aguardando plano, Requalificação vencida, Auditoria sugerida, Pendência de documento.
  - Clique na linha para abrir a ficha.
- **Ficha do fornecedor**, em abas:
  - **Qualificação** — andamento do processo;
  - **Documentos**;
  - **IQF / Inspeções** — gráfico do IQF por mês e média acumulada, NCs, todas as inspeções;
  - **Cadastro**;
  - **Trilha** — tudo o que mudou, por quem e por quê.
- **Imprimir lista** — a FORM 7.3.24 impressa, com os filtros da tela.
- **Recebimento** — clique numa linha para ver o relatório completo, os anexos e as alterações. **Excel** e **CSV** exportam o que está filtrado.
- **Dashboard** e **Itens críticos** — só consulta.

## 4. Inspetor (23002)

### Como lançar uma inspeção a partir do pedido de compra

1. Aba **Recebimento** → **Nova inspeção**.
2. Em **1. Origem**, digite o **Pedido de compra** e clique em **Buscar no Protheus**. O sistema traz:
   - o fornecedor e a situação dele para recebimento;
   - os itens do pedido e a **criticidade de cada item** pela lista de itens críticos;
   - a data prevista (C7_DATPRF);
   - as notas fiscais e pré-notas já digitadas.
3. Escolha o **item** recebido.
   - Se aparecer "**Repetir dados da última inspeção**", clique para trazer ESP., critério de aceitação, instrumento e nível usados da última vez.
   - Fornecedor **importado**: a data do pedido vira a **Coleta prevista**. Confira com a data de coleta combinada, que é a base do índice P.
4. Em **2. Recebimento**, confira nota fiscal, lote, as datas e a **Qtd. recebida**.
   - Nacional: **Entrega prevista / Entrega real**.
   - Importado: **Coleta prevista / Coleta real**.
5. Em **3. Inspeção**, escolha o **Nível de inspeção**. A **Qtd. inspecionada** é preenchida pela amostra do nível (NBR 5426). Se você inspecionou outra quantidade, digite por cima. **Nível 100** = lote inteiro.
6. Preencha **Qtd. aprovada** e **Qtd. reprovada** (somadas = inspecionada), **RNC nº** se houver, ESP., critério, resultado e instrumento.
7. Acompanhe o painel ao lado:
   - C, P, N e o **IQF desta entrega** (máx. 10);
   - as 3 entregas anteriores do mesmo item que formam o N;
   - como fica a **média do fornecedor**.
   Erros aparecem em "Para salvar, corrija:" e impedem salvar.
8. **Salvar inspeção**. O número do relatório é **automático e sequencial**. Depois de salvo, anexe fotos, laudo ou RNC no detalhe da inspeção e, se quiser, **Imprimir relatório**.

Sem pedido em mãos: escolha o **Fornecedor** na busca e informe o **Código do item**. O botão ao lado busca a última inspeção do item.

### Avisos e bloqueios do formulário

| O que aparece | O que significa |
|---|---|
| **Recebimento bloqueado.** Ninguém registra recebimento deste fornecedor — nem a Qualidade — até a Engenharia registrar o plano de ação | Fornecedor em classe C ou D aguardando plano. Não dá para salvar. Avise a Engenharia. |
| **Classe D — inspeção de 100% do lote** | O nível fica fixo em 100% e a inspecionada tem de ser igual à recebida. |
| **Somente a Qualidade pode registrar o recebimento deste fornecedor** | Fornecedor inativo, suspenso (por documento, requalificação ou manual) ou ainda em qualificação. Chame a Qualidade. |
| Alerta de **item crítico** | O item está na lista de itens críticos, mas o fornecedor não está qualificado nessa criticidade. A inspeção é salva e a Engenharia é avisada. |
| **não crítico**: o recebimento foi registrado, mas não entra no monitoramento | Normal para fornecedor de item de uso geral. |
| Fornecedor **não está no módulo de qualificação** | Peça à Qualidade para incluí-lo antes de lançar a inspeção. |

### Depois de gravar

A tela mostra a classe antes e depois e, se for o caso:
- **Recebimento deste fornecedor BLOQUEADO** — caiu para C ou D: a Engenharia precisa registrar o plano de ação.
- **Fornecedor REPROVADO e INATIVADO** — caiu para E.
- **Auditoria de acompanhamento sugerida** (PRO 5.6.2).

### Como corrigir uma inspeção que eu lancei

Abra a inspeção → **Editar** → corrija → **Motivo da alteração** → **Salvar alteração**. Tudo fica na trilha.
- Inspeções de outras pessoas, só a Qualidade altera.
- Anexo enviado por engano pode ser excluído por quem enviou nas primeiras 24 h; depois, só a Qualidade.

## 5. Engenharia (23003)

### Qualificar um fornecedor novo

1. Aba **Qualificação** → **Novo fornecedor**.
   - **Já cadastrado no Protheus**: busque pelo nome, código ou CNPJ e clique em **Selecionar**. A busca mostra quem já está no módulo, os importados (UF "EX") e os bloqueados no Protheus.
   - **Ainda não está no Protheus**: preencha os dados. O fornecedor recebe um código provisório (P00001), que depois é trocado pelo código do ERP na aba **Cadastro**.
   - Marque as **criticidades** (nenhuma = não crítico) e a origem: **Nacional — prazo pela data de entrega** ou **Importado — prazo pela data de coleta**.
   - **Cadastrar e iniciar qualificação**.
2. Na ficha, aba **Qualificação**, ficam o andamento (%) e as etapas:

| # | Etapa | Quem | O que fazer |
|---|---|---|---|
| 1 | Cadastro | Engenharia | Conferir os dados (**Editar cadastro**) |
| 2 | Criticidade | Engenharia | Marcar as criticidades e clicar em **Confirmar criticidade**. A tela sugere as criticidades pelos itens que o fornecedor entregou nos últimos 24 meses (notas de entrada × lista de itens críticos): **Usar a sugestão**. Não crítico pula as etapas seguintes até a aprovação. |
| 3 | Documentos | Engenharia | Registrar os documentos exigidos pela matriz do FORM 7.3.21 (ver abaixo) |
| 4 | Questionário (FORM 7.3.21) | Engenharia | **Gerar link** e mandar ao fornecedor |
| 5 | Análise do questionário | Qualidade | Avaliação crítica (capítulo 6) |
| 6 | Auditoria | Engenharia decide; Qualidade realiza | Ver "Decidir a auditoria" |
| 7 | Amostra | Engenharia | **Solicitar / registrar amostra**, ou **Dispensar amostra** com justificativa (ex.: serviço) |
| 8 | Avaliação | Engenharia | FORM 7.3.22 (dimensional) e FORM 7.3.23 (funcional) |
| 9 | Aprovação | Gerente de Engenharia | Assinatura eletrônica |

Cada etapa mostra se está feita, pendente, aguardando (ex.: resposta do fornecedor), não se aplica ou reprovada. O processo pode ser pausado (**Pausar** / **Retomar**) ou cancelado (**Cancelar processo**), sempre com motivo.

### Documentos (PRO 5.4)

Ficha → aba **Documentos** (ou etapa 3). A lista mostra o que é exigido para as criticidades do fornecedor e a situação de cada item: Em dia, Vencendo, Protocolo (no prazo), Protocolo vencido, Vencido, Pendente, Não aplicável.

| Botão | Para quê |
|---|---|
| **Registrar** / **Renovar** | Escolha o tipo: **Documento definitivo** (arquivo, número, emissão e validade quando exigida) ou **Protocolo (solicitação/renovação em andamento)** (arquivo do protocolo **e o prazo** para o documento definitivo). Renovar manda a versão atual para o histórico. |
| **Não se aplica** | Documento que não se aplica ao fornecedor (Nota 2 do FORM 7.3.21), com justificativa. |
| **Conferir** | Registra que a Engenharia verificou o documento. |
| Lápis (Corrigir) | Corrige nº, datas ou prazo, sempre com motivo. |
| **Pedir ao fornecedor** | Pede o documento por e-mail. Com o envio externo desligado, a tela mostra o texto pronto para você mandar pelo seu e-mail. |

Regras:
- Documento **já vencido** não é aceito como definitivo: registre o protocolo de renovação (com prazo) ou peça o atualizado.
- Protocolo vale **até o prazo**. Passado o prazo sem o definitivo, conta como vencido e o fornecedor pode ser suspenso.
- **Arquivos enviados pelo fornecedor (link do FORM)**: os arquivos que o fornecedor anexou no formulário aparecem como "aguardando conferência". Clique em **Registrar como documento**, confira e informe número e validade. Só então o arquivo passa a valer.
- **Histórico de documentos**: todas as versões, inclusive as substituídas e excluídas.

O painel **Controle de documentos** (aba Qualificação) reúne os documentos de todos os críticos. Filtre por Situação (Vencidos, Vencendo, Por protocolo, Pendentes) e pela janela de vencimento.

### O FORM 7.3.21 (link para o fornecedor)

Na etapa Questionário: **Gerar link** (ou **Renovar link**). Copie o link e mande ao fornecedor; se o envio de e-mail externo estiver ligado na Configuração, ele também vai por e-mail. O link vale 30 dias.

O fornecedor preenche **sem login**:
- dados cadastrais e até 3 contatos;
- documentação: para cada documento, se apresenta, comentário e o **arquivo** (PDF ou imagem, até 10 MB);
- os requisitos do questionário, por seção, com a orientação de cada um: **Sim / Parcial / Não**, com comprovação para Sim e Parcial;
- a **declaração** (assinatura eletrônica). O texto aceito fica gravado com data, hora e IP.

Requisito deixado em branco **conta como NÃO**; o fornecedor é avisado antes de enviar. Formulário que chegou em papel/PDF: **Transcrever formulário recebido em papel/PDF**.

### Decidir a auditoria (PRO 5.6)

Na etapa Auditoria, card **"Auditoria na qualificação — decisão da Engenharia"**: **A auditoria é necessária?** → necessária / **Não necessária** / **A decidir**, sempre com **justificativa** (ela vai para as conclusões do FORM).
- A tela mostra a sugestão do PRO 5.6.1: auditoria para **crítico B**, ou **crítico A sem certificação ISO**. A decisão é da Engenharia.
- Se for necessária, a Qualidade agenda e registra.

### Plano de ação — classes C e D

Quando o fornecedor cai para C ou D, a ficha mostra **Registrar plano de ação (libera)**. Na aba **IQF / Inspeções**, card **"Plano de ação do fornecedor (classes C e D)"**:
1. Anexe o documento do plano de ação enviado pelo fornecedor (PDF ou imagem).
2. Escreva o **Plano de ação** (resumo das ações, responsáveis e prazos).
3. **Registrar plano e liberar o recebimento**.

Resultado:
- **Classe C:** volta a receber por amostragem.
- **Classe D:** recebe **só com inspeção de 100% do lote**, até sair da D.
- Reative também no Protheus (vem o aviso "[Liberar no Protheus]").

Sem o anexo, o sistema pede confirmação ("**Registrar sem o arquivo do plano?**"). O plano pode ser revisto depois em **Atualizar plano**.

### Suspender, reativar, inativar

Na ficha:
- **Suspender** (com motivo): bloqueia o recebimento para os inspetores (só a Qualidade, com justificativa) e gera o aviso para inativar no Protheus.
- **Inativar** / **Ativar**: tira o fornecedor (ou devolve) das listas, do monitoramento e do recebimento, sem mudar o status.
- **Reativar**: o sistema exige, conforme o motivo da suspensão:

| Suspenso por | O que o sistema pede |
|---|---|
| Classe C/D (plano) | Registrar o plano de ação — o botão leva direto ao card do plano |
| Requalificação vencida | Aprovar a requalificação (FORM 7.3.28) — o botão **Requalificação (FORM 7.3.28)** leva ao processo |
| Documento vencido | Primeiro o documento regularizado (definitivo ou protocolo com prazo) |
| Fornecedor em C/D sem plano registrado | Registrar o plano antes |
| Os demais (manual, documento já regularizado) | **Auditoria de acompanhamento realizada depois da suspensão** (PRO 5.6.2) **ou** **Dispensar a auditoria de acompanhamento**, com justificativa |

Na reativação, o fornecedor volta ao resultado da última aprovação (**Automático (última aprovação)**), ou você escolhe Aprovado / Aprovado com restrição.

**Reprovado não se reativa.** Use **Nova qualificação (reprovado)**, com motivo. O fornecedor fica "em qualificação" durante o processo e, aprovado, **a média do IQF recomeça**.

### Requalificação anual (PRO 5.10 — FORM 7.3.28)

- A qualificação de fornecedor crítico vale **12 meses** a partir da aprovação.
- A ficha mostra "**Qualificação válida até**", e o Dashboard lista as vencidas, as que vencem em breve e as **sem data**.
- Os 46 críticos herdados da planilha não têm data e precisam ser programados.
- A Engenharia recebe aviso 60 e 30 dias antes.
- Vencida sem requalificação aprovada, o fornecedor é **suspenso** (com o alerta diário ligado).

Passo a passo — ficha → **Abrir requalificação** (ou **Iniciar requalificação anual**). As etapas:

| # | Etapa | O que fazer |
|---|---|---|
| 1 | FORM 7.3.28 | **Gerar link**. O fornecedor confirma os dados, reenvia só os documentos vencidos ou alterados e declara as alterações desde a última qualificação (processo, local de fabricação, matéria-prima, responsável técnico, certificações, registro ANVISA…), com a declaração. |
| 2 | Análise documental | Parecer sobre a documentação. Arquivos que o fornecedor anexou → registrar na aba **Documentos**. |
| 3 | Análise de desempenho | Parecer, reclamações e planos de ação. O sistema grava junto o retrato do IQF, das NCs e RNCs dos últimos 12 meses. Sem fornecimento no período: registrar no parecer (Nota 2). |
| 4 | Análise das alterações | **As alterações são aceitas?** e se exigem nova avaliação: **Novo questionário (FORM 7.3.21)**, auditoria ou **Nova amostra**. As etapas correspondentes passam a valer. |
| 5 | Aprovação | Gerente de Engenharia |

A tela mostra a **sugestão pelos critérios do PRO 7.3.7 item 5.10.2**:

| Situação | Sugestão |
|---|---|
| Documentação obrigatória vencida/pendente, Acordo de Qualidade não vigente, IQF classe E, alterações não aceitas ou FORM 7.3.28 não devolvido | **Não requalificado** |
| Documento por protocolo, ou IQF classe C ou D | **Requalificado com restrição** (exige plano e prazo) |
| Nenhum dos casos acima | **Requalificado** |

### Lista de Itens Críticos

Aba **Itens críticos**. Só a Engenharia altera; os demais consultam.
- **Incluir item**: código do item, criticidade (A, B, C ou D), descrição.
- **Cadastrar em lote (colar da planilha)**: uma linha por item, no formato `código | A/B/C/D | descrição`. O separador também pode ser `;` ou tabulação. A tela confere as linhas antes; depois, **Gravar lote**.
- **Editar**, **Desativar** e **Reativar** (com motivo). Item desativado deixa de sugerir criticidade e de gerar alerta; nada é apagado.
- Os códigos são comparados **sem zeros à esquerda** (`012614` = `12614`).

Enquanto a lista estiver vazia, a aba mostra "vazia", não há sugestão de criticidade e o recebimento não reconhece nenhum item crítico.

### Outras tarefas

- **Mudar criticidade** de fornecedor já qualificado: aba **Cadastro**, card Criticidade, com motivo. A classe é recalculada. Tirar todas as criticidades tira o fornecedor do monitoramento.
- **Atualizar o cadastro com o Protheus**: lista → **Sincronizar com Protheus**. Traz os fornecedores da SA2 que faltam (como não críticos) e atualiza nome, CNPJ, UF, nacional/importado e bloqueio. Não altera criticidade, status, avaliação do SGQ nem IQF.

## 6. Garantia da Qualidade (23004)

### Analisar o FORM 7.3.21

1. Ficha → etapa Questionário → **Ver e analisar** (o Dashboard lista os que aguardam a Qualidade).
2. Confira o cadastro, os contatos, a documentação declarada, cada resposta com a comprovação e a **Pontuação por seção**.
   - **Em branco → Não** (0 ponto).
   - Pontos: Sim = 2, Parcial = 1, Não = 0.
   - % = pontos ÷ (requisitos × 2).
3. Em **"Avaliação crítica da Garantia da Qualidade"**, escreva o parecer e **Registrar avaliação**:

| Pontuação | Resultado | O que acontece |
|---|---|---|
| **70% ou mais** | Aprovado | — |
| **50% a 69,99%** | Aprovado com restrição | Plano de ação obrigatório |
| **abaixo de 50%** | Reprovado | O processo é encerrado e o fornecedor fica Reprovado |

4. Ou **Devolver ao fornecedor para corrigir**, explicando o quê. Ele recebe um link novo.

### Auditoria (PRO 8.2.2)

Depois da decisão da Engenharia: **Agendar / registrar auditoria**:
- tipo: In loco, Remota ou Documental;
- datas, auditor, escopo;
- resultado: Conforme, Conforme com observações ou Não conforme. **Não conforme** exige as constatações ou o plano de ação solicitado ao fornecedor;
- a data de realização não pode ser futura;
- depois de salvar, anexe o relatório no cartão da auditoria.

**Auditoria de acompanhamento** (PRO 5.6.2): a ficha e o Dashboard mostram "**Auditoria de acompanhamento sugerida**" quando:
- o IQF ficou abaixo de 7 em 2 avaliações seguidas; ou
- houve 3 ou mais entregas com NC em 6 meses.

Registre pela ficha (**Auditoria de acompanhamento** / **Registrar auditoria de acompanhamento**). A auditoria realizada recalcula a sugestão e vale para a reativação de fornecedor suspenso.

### Receber material de fornecedor bloqueado

A Qualidade lança recebimento de fornecedor **inativo, suspenso ou ainda em qualificação**, preenchendo a **Justificativa do recebimento (Qualidade)**. A justificativa fica gravada na inspeção, e a lista do Recebimento marca "liberado pela Qualidade".

**Exceção:** fornecedor bloqueado por **plano de ação (classes C e D)** — ninguém recebe até a Engenharia registrar o plano.

Fornecedor que não está no módulo: no formulário da inspeção, **Cadastrar como não crítico** (ou **Novo fornecedor → Cadastro rápido (não crítico, sem processo)**).

### Inspeções

- Altera **qualquer** inspeção (com motivo) e **Excluir** (exclusão lógica: o registro continua guardado, só sai do IQF).
- **4. Ajuste manual de índice (Qualidade)**: escolha o valor de C, P ou N que existe na tabela e escreva a **Justificativa do ajuste**. Fica marcado com * e na trilha. Use para NC registrada fora da inspeção ou pedido sem data prevista.

### Corrigir registro herdado da planilha

1. Aba Recebimento → marque **com aviso de importação**.
2. Abra o registro → **Editar** → corrija só o que tem certeza (ex.: o ano da data) → motivo.
   - Erros que o registro já tinha **não impedem salvar**; só erro novo impede.
   - Se mexer em quantidade ou data, o C é recalculado; **P e N da planilha são mantidos**.
3. Pendências conhecidas:
   - 18 inspeções com data no futuro (Rel. 18723–18728, 19282–19283, 20554–20563) e 6 sem data;
   - 141 entregas com **N menor que 1 sem NC nas anteriores** — provável erro de preenchimento.

### Configuração

A Qualidade vê a aba Configuração; alterar é da Administração.

## 7. Gerente de Engenharia (23005)

### Assinar a qualificação ou a requalificação

1. Ficha → aba **Qualificação** → etapa **Aprovação** (o Dashboard lista as qualificações em andamento).
2. Se houver pendência, o sistema lista o que falta. Enquanto houver, só a decisão negativa fica disponível.
3. Botões disponíveis:

| Processo | Botões |
|---|---|
| Qualificação | **Aprovar**, **Aprovar com restrição**, **Reprovar** |
| Requalificação | **Requalificar**, **Requalificar com restrição**, **Não requalificar** |

   O sistema só oferece o que é permitido:
   - questionário ou avaliação "com restrição" → só "com restrição" ou reprovar;
   - na requalificação, a sugestão do PRO 5.10.2 ou uma decisão pior.
   - **Requalificar com restrição** exige o **plano de ação** e o **prazo de regularização**.
   - Reprovar / Não requalificar exige o motivo.
   - "Não requalificar" pode ser registrado a qualquer momento (ex.: FORM 7.3.28 não devolvido no prazo).
4. Leia a declaração, **digite sua senha da intranet** e **Assinar**.
5. O sistema registra nome, data/hora, IP e o código de verificação (**SHA-256**) do que foi assinado.

Depois de assinar:
- **Aprovado:** a qualificação passa a valer **12 meses**.
- **Não requalificado:** o fornecedor fica suspenso até a regularização, e a Engenharia recebe o aviso para inativá-lo no Protheus.

Senha errada não registra nada (a tentativa fica na trilha).

## 8. Administração (23006)

Tudo em **Configuração**.

### Regras de cálculo

As regras **não se editam**: cria-se uma versão nova. A versão ativa é a **PRO 7.3.7 REV OUT261**; a da planilha fica só para leitura (histórico).
1. **Índice P em cada versão** compara, dia a dia, os valores das versões.
2. **Nova versão a partir desta**:
   - ajuste C;
   - as **três tabelas de P** (nacional — entrega; importado — coleta; antecipação);
   - N (por fornecedor + item);
   - classes, com a ação de cada uma: Nenhuma / Bloquear até o plano de ação / Bloquear até o plano + só 100% / Reprovar e inativar;
   - questionário;
   - **Requalificação e auditoria** (meses, antecedência, IQF limite, avaliações consecutivas, NCs mínimas, janela em meses);
   - amostragem.

   Dê um nome e diga o que mudou.
3. **Ativar esta versão** (com motivo) recalcula a classe de todos os fornecedores críticos. **Inspeções já lançadas não mudam**: cada uma guarda a versão com que foi calculada.

### Documentos exigidos

Para cada tipo de documento:
- a regra para **Crítico A, B, C e D**: Obrigatório / Somente se aplicável / Não se aplica;
- se é **Só de fornecedor nacional**;
- se **Exige data de validade**;
- a condição.

"Somente se aplicável" não bloqueia a aprovação.

### Requisitos (FORM 7.3.21)

Cada requisito tem código, seção, texto, **Orientação ao fornecedor (opcional)** e **Aplica-se a** (TODOS, CRITICO_A, CRITICO_B, CRITICO_C ou CRITICO_D).
- **Novo requisito** — cadastra um.
- **Em lote** — uma linha por requisito: `código | seção | texto do requisito | aplicável | orientação ao fornecedor`, depois **Gravar lote**.
- Requisito já respondido não se apaga: desative.

### Notificações

- E-mails da **Qualidade** e da **Engenharia** (um por linha).
- Interruptores:
  - **Ações automáticas por classe**;
  - **Suspender fornecedor com documento obrigatório vencido** (vale também para protocolo vencido);
  - **Suspender fornecedor com requalificação anual vencida**;
  - **Enviar e-mails ao FORNECEDOR** — deixe desligado até a Qualidade aprovar os textos.
- Prazos:
  - **Avisar documento com (dias)** — padrão 30 e 1;
  - **Avisar requalificação com (dias)** — padrão 60 e 30, no mínimo 30;
  - **Validade do link dos formulários (dias)**.
- O alerta diário (07:10) só roda se a TI ligar `QF_ALERTAS_ATIVO=1` no servidor; a tela mostra se está ligado. Abaixo, o registro de tudo que foi enviado ou retido.

### Importação

1. **FORM 7.3.24** (lista): escolha o arquivo → **Simular** → leia o relatório → **Importar**.
2. **FORM 7.4.3.H** (inspeções): **Simular** → confira a validação **INFITEK (003794): 14 inspeções, IQF 10,2857, classe A** → **Importar**. O relatório compara o banco com a planilha fornecedor a fornecedor (deve dar 0 divergências).
3. Pode repetir: só entra o que falta, e o que foi corrigido no módulo não é sobrescrito.

**Sincronizar com o Protheus** traz os fornecedores da SA2 que faltam, como não críticos.

### Outros

- **Nº do relatório (administrador)** diferente do automático: só a Administração informa.
- **Trilha geral**: todas as alterações do módulo, filtráveis.
- **Permissões**: o que cada nível faz.

---

## 9. Perguntas frequentes

**Por que não consigo receber deste fornecedor?** Depende da mensagem no formulário:
- **"Recebimento bloqueado" (plano de ação)**: o fornecedor caiu para C ou D. Ninguém recebe até a Engenharia registrar o plano na ficha (aba IQF / Inspeções).
- **"Somente a Qualidade pode registrar"**: o fornecedor está inativo, suspenso ou em qualificação. A Qualidade lança com justificativa.
- **"Classe D — inspeção de 100% do lote"**: dá para receber, mas só inspecionando o lote inteiro.
- **Não aparece na busca**: o inspetor só vê fornecedores aprovados; inativos não aparecem para ninguém. Fale com a Qualidade.

**Por que o fornecedor não tem classe?** Ou ele é **não crítico** (fora do monitoramento — o recebimento continua registrado), ou ainda não tem inspeção, ou voltou de uma reprovação e ainda não teve entrega depois da reaprovação.

**O fornecedor voltou de reprovado e a média zerou.** É de propósito. Na reaprovação, a média do IQF recomeça na data da aprovação. As inspeções antigas continuam no histórico (esmaecidas no gráfico), mas fora da média; senão o mesmo histórico o reprovaria de novo no primeiro recebimento.

**Por que o N caiu se este lote está perfeito?** O N olha as 3 entregas **anteriores** do mesmo item. Uma NC recente pesa nas próximas.

**Por que o P de um importado é pela coleta?** O PRO 7.3.7 mede o prazo do importado pela **data de coleta**. Confira a coleta prevista: a data do pedido é copiada para ela, mas pode não ser a combinada.

**A lista de itens críticos está vazia — e agora?** Sem ela, nenhum item é reconhecido como crítico no recebimento e a ficha não sugere criticidade. A Engenharia cadastra na aba Itens críticos (pode colar em lote).

**Recebi "[Bloquear no Protheus]". O que faço?** Engenharia: inative o fornecedor na SA2 do Protheus. Quando chegar "[Liberar no Protheus]", reative.

**Apaguei uma inspeção por engano.** Nada é apagado de verdade. A Qualidade vê as excluídas e o motivo na trilha.

**O e-mail não chegou ao fornecedor.** Veja Configuração → Notificações. Com o envio externo desligado, a mensagem aparece como "retido" e o texto fica disponível para envio manual.
