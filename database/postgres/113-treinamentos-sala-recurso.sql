-- Sala/recurso do M365 reservável por sessão. `local` continua sendo o NOME exibido
-- (nome da sala do 365 ou texto livre); `sala_email` é o mailbox do recurso usado
-- para RESERVAR/bloquear a agenda da sala (attendee type=resource no evento do organizador).

ALTER TABLE tab_treina_sessao ADD COLUMN IF NOT EXISTS sala_email varchar(200);
