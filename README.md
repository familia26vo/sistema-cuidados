# Care Stock — instalação local

## Conteúdo

- `public/index.html`: frontend.
- `server.js`: backend Node.js/Express.
- `schema.sql`: tabelas do Neon Postgres.
- `.env.example`: modelo de configuração.
- `package.json`: dependências.

## Instalação

1. Instale Node.js 20 ou superior.
2. Copie `.env.example` para `.env`.
3. Preencha `DATABASE_URL` com a conexão do banco Neon.
4. Execute o `schema.sql` no Neon.
5. No terminal, dentro desta pasta, execute:

```bash
npm install
npm start
```

6. Abra `http://localhost:3000`.

## Acesso pela rede local

O servidor já escuta em `0.0.0.0`. Descubra o IP do computador servidor:

- Windows: `ipconfig`
- Linux/macOS: `hostname -I`

Em outro dispositivo conectado ao mesmo Wi-Fi, abra `http://IP_DO_SERVIDOR:3000`.

Não faça redirecionamento de porta no roteador. Essa configuração é somente para a rede local.

## Primeiro acesso

Defina no `.env`:

```env
BOOTSTRAP_ADMIN_EMAIL=123
BOOTSTRAP_ADMIN_PASSWORD=vanderson
```

O usuário inicial é criado somente quando a tabela `users` estiver vazia. Depois que o banco estiver funcionando, faça um backup pelo painel administrativo e altere a senha para uma mais forte.

## Backup manual

No painel administrativo, abra **Usuários** e use **Baixar backup JSON**. Guarde também a pasta `uploads/`, pois ela contém os comprovantes PDF e imagem.
