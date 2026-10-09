// services/ciospContrato.js — o texto do contrato que o talão de pedido traz impresso.
//
// O talão de pedido NÃO é um comprovante: é uma "Proposta para compra e venda com
// reserva de domínio", e o verso dele tem onze cláusulas. Ao imprimir pela intranet,
// o documento precisa sair com o mesmo texto — por isso ele mora aqui, num lugar só,
// com versão.
//
// ⚠️ TEXTO JURÍDICO: transcrito do talão CIOSP25. Qualquer ajuste é do jurídico, não
// da TI — e mudar o texto exige subir a VERSAO, porque o pedido impresso guarda qual
// versão foi usada. Sem isso não dá para saber, meses depois, o que o cliente assinou.
//
// Três cláusulas têm efeito no cálculo e já estão implementadas em ciospDocs.js:
//   3 — prazo de expedição em branco vale 30 dias;
//   5 — frete grátis, menos na região amazônica, onde a venda é acrescida de 3%;
//  10 — desistência tem multa de 10%.

const VERSAO = 'CIOSP25';

const VENDEDORA = {
  razao: 'GNATUS EQUIPAMENTOS MÉDICOS E ODONTOLÓGICOS LTDA.',
  cnpj: '09.609.356/0001-00',
  ie: '204.223.520.113',
  cidade: 'BARRETOS/SP',
  titulo: 'PROPOSTA PARA COMPRA E VENDA COM RESERVA DE DOMÍNIO DE EQUIPAMENTOS E PERIFÉRICOS QUE DEPENDE DA ACEITAÇÃO'
};

const ATENCAO =
  'Informamos que os prazos estimados acima são sucessivos, de modo que o prazo de entrega de seu pedido ' +
  'começará a ser contado após os seguintes passos concluídos: 1. Documentos Entregues corretamente ' +
  '(necessários à identificação do PROMITENTE-COMPRADOR e à formalização da proposta); 2. Aprovação dos ' +
  'Contratos devidamente preenchidos; 3. Aprovação Financeira e confirmação do pagamento; 4. Fabricação; ' +
  '5. Separação; 6. Faturamento; 7. Expedição. A fluência dos prazos fica condicionada à regularidade dos ' +
  'pagamentos ajustados.';

const PRAZOS = [
  'Prazo de fabricação individualizado para cada produto, vide QUADRO 01.',
  'Prazo de conferência e liberação do pedido após assinatura correta do contrato de compra: 02 dias úteis.',
  'Prazo para confirmação de pagamento e liberação do departamento financeiro: 03 dias úteis.',
  'Prazo de faturamento e expedição: 02 dias úteis a contar do prazo de fabricação de cada produto.'
];

const CLAUSULAS = [
  {
    n: 1, titulo: 'PAGAMENTO',
    texto:
      'A falta de pagamento de quaisquer das parcelas antecipará o vencimento das demais, autorizando a ' +
      'imediata execução do saldo devedor. Fica autorizado a emissão de duplicatas/boletos para cobrança ' +
      'dessas parcelas e o seu protesto na hipótese de não pagamento, ficando ainda autorizada a cessão do ' +
      'crédito. A compra e venda é realizada com reserva de domínio do(s) equipamento(s) que é garantia dos ' +
      'pagamentos, assumindo o COMPRADOR a qualidade de depositário fiel. Atraso no pagamento: Aplicação de ' +
      'multa de 2% (dois por cento), correção monetária (IGPM/FGV) e juros de mora de 1% (um por cento) ao ' +
      'mês, pro rata die e ainda a suspensão da entrega dos equipamentos. Inadimplemento: A critério da ' +
      'VENDEDORA (i) optar pela execução da obrigação de pagamento (artigo 784, III do CPC) ou (ii) retomada ' +
      'da posse dos objetos condicionalmente vendidos.'
  },
  {
    n: 2, titulo: 'ACEITE DA PROPOSTA',
    texto:
      'A proposta passará a ter eficácia definitiva de Contrato de Compra e Venda com Reserva de Domínio após ' +
      'a aceitação expressa da VENDEDORA ou pela entrega de todos os produtos (somente nestas hipóteses, sem ' +
      'exceção). Hipóteses de não aceitação: a) não aprovação de pedido de parcelamento; b) não aprovação de ' +
      'cadastro (usuais de mercado); c) morosidade ou dificuldade para aprovação do crédito; d) irregularidade ' +
      'na descrição e especificação dos produtos, preços, condições de pagamento, prazo de entrega do produto, ' +
      'dados e assinaturas. A não aceitação da proposta desobriga as partes de todas as obrigações previstas. ' +
      'Por se tratar de Contrato de Compra e Venda com Reserva de Domínio, nos moldes dos artigos 521 e ' +
      'seguintes do CC, o COMPRADOR declara-se CIENTE que a transferência da propriedade do produto só ' +
      'ocorrerá após o efetivo pagamento total do preço ajustado. A partir do recebimento do produto, o ' +
      'COMPRADOR é o responsável exclusivo pelos riscos inerentes dele decorrentes, bem como pela sua boa ' +
      'conservação. Para validação do presente instrumento, é obrigatória a assinatura do COMPRADOR, sem a ' +
      'qual não se dará por constituída a contratação.'
  },
  {
    n: 3, titulo: 'EXPEDIÇÃO',
    texto:
      'A previsão de expedição dos produtos começa a fluir após a fabricação. A entrega ao destino final após ' +
      'a expedição dependerá da localização geográfica do cliente e as variáveis logísticas necessárias para o ' +
      'deslocamento até o mesmo e será feita em horário comercial, podendo ser alterada na hipótese de casos ' +
      'fortuitos ou de força maior. Caso a entrega não possa ser realizada por culpa do COMPRADOR, este deverá ' +
      'arcar com as eventuais despesas de transporte e armazenagem do produto. A ausência do preenchimento do ' +
      'prazo de expedição será considerado como prazo de expedição de 30 (trinta) dias (úteis). A solicitação ' +
      'do COMPRADOR para entrega parcial dos equipamentos dependerá da disponibilidade e concordância da ' +
      'VENDEDORA, sendo que, nesta hipótese, caberá ao COMPRADOR arcar com eventuais custos excedentes com ' +
      'transporte e armazenagem dos produtos não entregues na data aprazada a seu pedido.'
  },
  {
    n: 4, titulo: 'INSTALAÇÃO',
    texto:
      'Serviço de instalação e despesas de deslocamento do técnico serão pagas pelo COMPRADOR, por ocasião do ' +
      'atendimento. É de responsabilidade integral do COMPRADOR a preparação do local conforme Manual de ' +
      'Pré-Instalação. No caso do local estar em desacordo com as normas para a montagem e o técnico tenha que ' +
      'retornar, serão cobrados o deslocamento e a hora técnica.'
  },
  {
    n: 5, titulo: 'FRETE',
    texto:
      'Frete Grátis, exceto para os Estados da região Amazônica (Acre, Amazonas, Rondônia, Roraima, Pará e ' +
      'Amapá), para os quais o valor total da venda será acrescido de 3% (três por cento).'
  },
  {
    n: 6, titulo: 'USO DO EQUIPAMENTO',
    texto:
      'O COMPRADOR declara ter ciência de que os produtos adquiridos devem ser utilizados de acordo com as ' +
      'indicações de uso pretendido, exclusivamente por profissional da área da saúde com capacitação para ' +
      'tanto, conforme descrito em manual.'
  },
  {
    n: 7, titulo: 'GARANTIA',
    texto:
      'A garantia dos produtos é aquela estabelecida em lei, mas podem existir prazos e condições diferentes ' +
      'com relação a cada produto (vide manual do produto). Perda da garantia: a) Armazenagem do equipamento ' +
      'por mais de 03 (três) meses a contar da data da emissão da nota fiscal de venda até a data da efetiva ' +
      'instalação; b) Reparo por técnicos não autorizados; c) Abertura da embalagem e instalação do ' +
      'equipamento por técnico não autorizado; d) Armazenamento inadequado ou violação; e) uso incorreto do ' +
      'equipamento; f) uso de produtos de limpeza não indicados pela fábrica; g) quedas ou batidas que o ' +
      'equipamento possa sofrer ou falta de observação e atendimento às orientações do Manual do Proprietário. ' +
      'Defeito de fabricação dos produtos de terceiros (vide Certificado de Garantia).'
  },
  {
    n: 8, titulo: 'ASSISTÊNCIA TÉCNICA',
    texto: 'A garantia não exime o cliente do pagamento de deslocamento e visita técnica.'
  },
  {
    n: 9, titulo: 'DISPOSIÇÕES GERAIS',
    texto:
      'Todas as comunicações, avisos e notificações decorrentes do presente instrumento, serão realizadas por ' +
      'escrito, por meio de carta registrada, notificação ou qualquer outra forma escrita passível de ' +
      'confirmação de recebimento, e sempre com cópia aos e-mails abaixo, aos seguintes endereços.'
  },
  {
    n: 10, titulo: 'DESISTÊNCIA',
    texto:
      'Multa em favor da VENDEDORA no percentual de 10% (dez por cento) sobre o valor total do contrato, ' +
      'acrescida de eventuais despesas relativas às custas financeiras, à expedição e/ou ao transporte, ' +
      'autorizada a retenção de valores pagos pelo COMPRADOR. NÃO SERÁ ACEITA A DESISTÊNCIA NA HIPÓTESE DE ' +
      'PAGAMENTO POR INTERMÉDIO DE INSTITUIÇÃO BANCÁRIA/FINANCEIRA.'
  },
  {
    n: 11, titulo: '',
    texto:
      'Fica autorizado o registro do presente contrato (Lei nº 6.015/73) e eleito o foro de Barretos, Estado ' +
      'de São Paulo. Para que surtam os efeitos legais, firmam o presente em três vias de igual teor, na ' +
      'presença de duas testemunhas.'
  }
];

module.exports = { VERSAO, VENDEDORA, ATENCAO, PRAZOS, CLAUSULAS };
