# Elo Brasil 🇧🇷

Rede para conectar pessoas e empresas que compartilham os mesmos valores: comércio local, vagas de trabalho,
feed por cidade e ajuda mútua. Todo perfil passa por **verificação de identidade** (selfie com documento +
foto do documento + Instagram) ou entra por **convite** de um membro verificado.

O nome, o slogan e os textos são configuráveis no painel. As cores seguem a bandeira do Brasil.

## O que o sistema faz

**Rede (público e membros)**

- **Conta** de pessoa ou empresa, com login por e-mail e senha. Consentimento LGPD no cadastro.
- **Verificação**: o membro envia selfie segurando o documento, foto do documento e Instagram. As imagens ficam em
  área privada (só a moderação vê) e são **apagadas automaticamente** quando a verificação é aprovada ou recusada.
  Quem entra por convite tem prioridade e não precisa informar Instagram.
- **Convites**: membro verificado ganha 5 convites. O convidado fica ligado a quem convidou (responsabilidade).
- **Diretório** de empresas, profissionais e membros verificados: busca por nome, cidade, tipo e categoria.
  Avaliações (1 a 5 estrelas) só por membros verificados. WhatsApp visível só para membros verificados.
- **Vagas**: empresas verificadas publicam; membros verificados se candidatam com um clique. A empresa vê o perfil
  e o contato de quem se candidatou. Vagas são abertas a todos os membros.
- **Feed** por cidade: publicações de texto, denúncia de post ou perfil, remoção do próprio post.
- **Corrente do Bem** (`/corrente`): o módulo de doações original. Lista do que a beneficiária precisa, ofertas,
  pedidos de outras pessoas e repasse das doações que sobram, com sugestões por IA.

**Moderação (`/admin`)**

- Entra com a senha `ADMIN_PASSWORD` ou com uma conta de membro com papel "moderador".
- **Fila de verificação**: vê as imagens, a recomendação da IA, aprova ou recusa com motivo.
- **Membros**: busca, verificar manualmente, tirar selo, dar convites, tornar moderador, suspender.
- **Denúncias**: remover publicação, suspender conta, resolver.
- **Corrente do Bem**: necessidades, ofertas (com repasse por IA) e pedidos.
- **Configurações**: nome da rede, slogan, descrição, cadastro aberto ou só por convite, dados da campanha.

**IA (Claude API)**, ativa com `ANTHROPIC_API_KEY`:

- **Triagem de verificação**: checa se o documento está legível, se a selfie mostra um rosto real com documento,
  se parece a mesma pessoa e se o nome confere. Recomenda aprovar / revisar / rejeitar. **A decisão é sempre da
  moderação.** A IA não avalia aparência, opinião ou política de ninguém, e não transcreve números do documento.
- **Repasse de doações** (Corrente do Bem): liga a oferta ao item certo e sugere para quem repassar.

## Rodando

Precisa do Node.js 22.13 ou mais novo (SQLite embutido, sem compilar nada).

```bash
npm install
cp .env.example .env     # edite ADMIN_PASSWORD, SESSION_SECRET e, se quiser IA, ANTHROPIC_API_KEY
export $(cat .env | xargs)
npm start
```

Abra http://localhost:3000. Painel em http://localhost:3000/admin. Testes: `npm test`.

## Variáveis de ambiente

| Variável             | Obrigatória | Descrição                                                                 |
| -------------------- | ----------- | ------------------------------------------------------------------------- |
| `ADMIN_PASSWORD`     | sim         | Senha do painel de moderação.                                             |
| `SESSION_SECRET`     | recomendada | Segredo dos cookies de sessão. Se vazia, usa a senha.                     |
| `ANTHROPIC_API_KEY`  | não         | Chave da Claude API. Ativa a triagem de verificação e o repasse por IA.   |
| `IA_MODELO`          | não         | Modelo da IA (padrão `claude-opus-5-5`).                                  |
| `DATABASE_PATH`      | não         | Arquivo SQLite (padrão `./data/corrente.db`). Uploads ficam na mesma pasta.|
| `URL_BASE`           | não         | URL pública (para os links de convite). Se vazia, usa o host da requisição.|
| `PORT`               | não         | Porta (padrão `3000`; o Railway define sozinho).                          |

## Publicando no Railway

Já está publicado em https://corrente-do-bem-production.up.railway.app com volume em `/data`.
Para um projeto novo:

1. **New Project → Deploy from GitHub repo**. O `railway.json` define build, `npm start` e healthcheck `/health`.
2. **Variables**: `ADMIN_PASSWORD`, `SESSION_SECRET`, `ANTHROPIC_API_KEY` (opcional), `DATABASE_PATH=/data/corrente.db`.
3. **Add Volume** montado em `/data` (banco e fotos ficam lá; sem volume os dados somem a cada deploy).
4. **Settings → Networking → Generate Domain**.

## Privacidade e lei (resumo do que foi considerado)

- Opinião política é dado sensível na LGPD. O sistema **não pede nem guarda** ideologia declarada. A afinidade
  vem do convite e da comunidade. O consentimento no cadastro cobre os dados coletados.
- Fotos de documento são usadas só para confirmar identidade e são apagadas após a decisão.
- Vagas são abertas a todos os membros verificados; a empresa decide quem contrata. Os termos lembram as empresas
  da legislação (Constituição art. 3º IV, Lei 9.029/95, Convenção 111 da OIT).
- `views/rede/termos.ejs` tem uma versão inicial dos termos. Vale revisão jurídica antes do lançamento.

## Estrutura

```
src/server.js           Express, middlewares, montagem das rotas
src/db.js               SQLite: config + Corrente do Bem
src/db-rede.js          SQLite: usuários, convites, verificações, posts, denúncias, vagas, avaliações
src/auth.js             sessão por cookie e guardas (login, verificado, empresa)
src/upload.js           uploads (fotos públicas / verificação privada)
src/ia.js               Claude API: triagem de verificação e repasse de doações
src/routes/auth.js      entrar, cadastrar, sair
src/routes/rede.js      feed, diretório, perfil, verificação, convites, vagas
src/routes/publico.js   Corrente do Bem (montado em /corrente)
src/routes/admin.js     moderação (+ /admin/corrente/*)
views/rede/             telas da rede
views/corrente/         telas da Corrente do Bem
views/admin/            painel de moderação
public/style.css        estilo verde-amarelo-azul, mobile-first
test/                   node:test (rede, corrente, IA)
```
