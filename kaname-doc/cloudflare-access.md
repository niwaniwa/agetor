# Cloudflare 経由のブラウザー接続

作業日: 2026-10-02。ユーザー指定の公開先は `https://kaname.niri.la`。

状態: `https://kaname.niri.la` の公開経路を設定済み。公開ホスト対応を稼働版へ反映し、Docker bridge からの認証・API・SSE を確認した。ユーザーが Cloudflare Access 認証後に KANAME のログイン画面を開けることも確認済み。

ユーザーの選択に従い、KANAME 本体はホスト上の既存 tmux 起動を維持した。Docker 化は行わず、既存の `cloudflare-d` コンテナから到達する中継だけを systemd の user unit として追加した。

## 接続経路

このサーバーの既存 `cloudflare-d` は Docker の `cloudflared` bridge network 内で動く。コンテナの `localhost` はホストの localhost とは別なので、公開ルートのサービス URL に `http://localhost:4318` は使わない。

```text
ブラウザー → https://kaname.niri.la → Cloudflare Tunnel
  → cloudflare-d コンテナ
  → http://172.20.0.1:4318（Docker bridge のホスト側、中継）
  → http://127.0.0.1:4318（KANAME ブラウザー入口）
  → http://127.0.0.1:4317（内部 API）
```

`172.20.0.1` はこの環境で調査した Docker network の Gateway。別の環境では `docker network inspect cloudflared` で実値を確認する。内部 API の4317を公開ルートに指定しない。

中継の雛形は `deploy/kaname-tunnel-proxy.socket` と `.service`。ホスト既存の `systemd-socket-proxyd` で TCP を中継し、Host／Origin、SSE、WebSocket を保持する。待受けを `0.0.0.0` に広げない。この IP の指定はファイアウォールによるアクセス制限ではなく、同じ bridge 内の他コンテナも到達できるため、KANAME の認証は必須のままとする。

KANAME 本体は `tmux -L kaname-web-service` の `web` セッションで動かす。中継用 user unit を追加しても、本体が systemd 管理になったり、ホスト再起動後に自動起動するようになったりはしない。

## KANAME の設定

起動環境に次を追加する。

```bash
KANAME_PUBLIC_ORIGIN=https://kaname.niri.la
```

HTTPS の origin を完全一致で指定する。末尾 `/`、パス、クエリー、資格情報は含めない。未設定時は従来の loopback Host だけを許可する。

公開 Host では、設定した HTTPS Origin に照合し、認証 Cookie を `__Host-kaname_session_<port>` として `Secure; HttpOnly; SameSite=Strict; Path=/` を付ける。Domain は付けず、別サブドメインからの親ドメイン Cookie 注入との競合を防ぐ。書き込みと WebSocket は同じ Origin を要求する。`Forwarded`／`X-Forwarded-*` の値で許可先は増やさない。既存の HTTP localhost 接続と従来の Cookie 名も維持する。

利用者は HTTPS URL を開き、ホストの `~/.kaname/web-login-token` を KANAME のログイン画面に入力する。トークンを Cloudflare の URL や Host Header に入力したり、チャットに貼ったりしない。プロジェクトのパスは、接続元 PC ではなく KANAME が動くサーバー上のパスを指定する。

## Cloudflare 側の設定

この環境で確認できた資格情報は既存 Tunnel の実行用のみで、DNS／Tunnel 設定を編集する管理用認証はない。ユーザーが管理画面で既存 Tunnel に次の公開ルートを追加し、Service type が HTTP であることを確認した。

| 項目 | 値 |
|---|---|
| Hostname | `kaname.niri.la` |
| Service type | `HTTP` |
| Service URL | `172.20.0.1:4318` |
| HTTP Host Header | `kaname.niri.la`（公開 Host を保持） |

既存の `git.niri.la`、`cicd.niri.la`、`ssh.niri.la` のルートを保持する。Cloudflare の現行ドキュメントでは Networking → Tunnels → 対象 Tunnel → Routes → Add route → Published application の順で追加する。UI の表示が異なる場合は既存 Tunnel の公開アプリケーション設定を開く。[公式の公開ルート手順](https://developers.cloudflare.com/tunnel/get-started/)

この公開先では Cloudflare Access のサインイン画面を確認済み。利用者の許可設定はユーザーが管理する。Access 認証に加えて KANAME のログイントークン認証も継続する。KANAME の既存ログイン試行制限は全利用者共通（失敗10回／分）のため、Access を外して一般公開すると第三者の失敗試行でログイン待ちが発生しうる。

Quick Tunnel は SSE 非対応なので、ログ配信を使う KANAME の公開には使わない。[Quick Tunnels の制約](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

## 検証と運用記録

- 既存 Tunnel は稼働中で、今回の作業開始時に `kaname.niri.la` のルートと DNS はなかった。
- 公開 Host／HTTPS Origin、認証、資格情報の除去、ログアウト、SSE／WebSocket のテストは模擬バックエンドを使う。実 CLI、外部通知、GitHub 書き込みは行わない。
- systemd 中継雛形の `systemd-analyze --user verify` は成功。
- `bun test src/bun/web-server.test.ts` は21件・185 assertions 成功。公開／ローカル Cookie の分離、認証、API、SSE／WebSocket、Origin 拒否とログアウトによる接続失効を含む。型チェックと `git diff --check` も成功。
- 公開 URL は Cloudflare Access を経由する。Access の本人認証はユーザーが行い、その後 KANAME のログイン画面が表示されたことを確認した。Access 後の公開 URL を使った KANAME ログイン・API・ログ配信・再読み込みの一連の自動検証は未実施。

2026-10-02 17:41 UTC の反映では、既存のデータと起動環境を保持して KANAME 管理サービスを再起動した。反映完了時の Bun PID は `1942890`。`KANAME_PUBLIC_ORIGIN=https://kaname.niri.la` が設定済みで、中継 unit は `~/.config/systemd/user/` にインストールされ、socket は有効化・起動済み。待受けは `172.20.0.1:4318`、`127.0.0.1:4318`、`127.0.0.1:4317` だけで、全インターフェースには広げていない。

`~/.config/kaname/kaname.env` にも公開 origin を記録した。ただし現在の tmux 起動はこのファイルを自動で読み込まない。次の手動起動でも環境変数を明示する。

反映前のバックアップ:

```text
/home/nirila/.local/state/kaname/backups/20261002T174150Z-cloudflare-uvj4yfp_
```

| 稼働環境での確認 | 結果 |
|---|---|
| 既存の localhost ブラウザーセッション | 再起動後も有効 |
| タスク・実行履歴・ログ・プロジェクト | 件数と内容ハッシュが反映前と一致（順に3・4・477・3件） |
| ログイントークン・内部 API トークン | 反映前と同じ内容 |
| Docker bridge 経由の認証・API | 成功 |
| 同じ Docker network のコンテナから中継への接続 | 成功。未ログイン状態を取得できることを確認 |
| 公開 Host／HTTPS Origin | 正しい組み合わせを受け入れ、未許可の組み合わせを拒否 |
| 公開 Cookie | `__Host-` 名と `Secure` 属性を確認 |
| ログアウト | セッション失効を確認 |
| Docker bridge 経由の SSE | 認証後の `/api/events` が200で即座に `: connected` を返すことを確認。確認用セッションだけをログアウト |
| 稼働版の localhost 実 Chromium | ログイン・画面表示・既存データ・再読み込み等の6項目が成功 |
| 外部 DNS | 作業中に Cloudflare の IP へ解決する状態を確認 |
| 公開 URL の入口 | Cloudflare Access のサインイン画面へ到達 |
| Access 認証後の公開画面 | ユーザーが KANAME のログイン画面の表示を確認 |
| 公開 URL での KANAME 認証後の自動検証 | 未実施。Access の本人認証はユーザーが保持 |

localhost の実ブラウザー確認結果は `/tmp/kaname-live-browser-izJaMT/result.json`。公開 URL の確認はユーザーによる画面確認であり、公開経路での実 CLI 起動やタスク操作を検証済みとはしていない。

この反映による DB の移行はない。commit・push・PR 作成・マージ・remote／履歴変更、実 CLI の起動、外部通知、GitHub 書き込みは行っていない。

## KANAME 本体の手動再起動

以下は現在のホスト用の起動例。必要な独自の環境変数がある場合は同じ値を引き継ぐ。Runner 用の `AGETOR_TMUX_SOCKET` は現在未設定のままであり、管理用 tmux の `kaname-web-service` と混同しない。Bun のパスは現在の配置先なので、ホスト再起動後などに `/tmp` が消えていれば Bun を準備し直す。

まず管理用セッションの PID とコマンドを確認する。現在は pane が Bun を直接実行している。

```bash
KANAME_SERVICE_PID=$(tmux -L kaname-web-service display-message -p -t web '#{pane_pid}')
ps -p "$KANAME_SERVICE_PID" -o pid=,comm=
```

対象が KANAME の Bun と確認できたら、そのプロセスだけを終了して待つ。全 tmux セッションを終了する操作は行わない。

```bash
kill -TERM "$KANAME_SERVICE_PID"
while kill -0 "$KANAME_SERVICE_PID" 2>/dev/null; do sleep 0.2; done
```

続いて同じデータ・ポート・公開 origin で起動する。

```bash
tmux -L kaname-web-service new-session -d -s web -c /home/nirila/project/agetor \
  'exec env AGETOR_DATA_DIR=/home/nirila/.kaname AGETOR_API_PORT=4317 KANAME_WEB_PORT=4318 KANAME_PUBLIC_ORIGIN=https://kaname.niri.la /tmp/kaname-bun/node_modules/.bin/bun src/bun/kaname.ts'
```

## 中継の状態確認

KANAME を動かすユーザーで実行する。

```bash
systemctl --user status kaname-tunnel-proxy.socket kaname-tunnel-proxy.service
systemctl --user is-enabled kaname-tunnel-proxy.socket
journalctl --user -u kaname-tunnel-proxy.service -n 30 --no-pager
tmux -L kaname-web-service list-panes -t web -F '#{pane_pid} #{pane_current_command}'
```

中継の service は socket への接続で起動するため、接続前に service だけが inactive でも socket が待ち受けていれば起動できる。本体の状態は別途 tmux と `http://127.0.0.1:4318` で確認する。

## 公開を停止して localhost のみに戻す

まず中継を停止する。

```bash
systemctl --user disable --now kaname-tunnel-proxy.socket
systemctl --user stop kaname-tunnel-proxy.service
```

続いて上記の PID 確認・終了手順で KANAME 本体を止め、公開 origin 未設定で起動する。

```bash
tmux -L kaname-web-service new-session -d -s web -c /home/nirila/project/agetor \
  'exec env -u KANAME_PUBLIC_ORIGIN AGETOR_DATA_DIR=/home/nirila/.kaname AGETOR_API_PORT=4317 KANAME_WEB_PORT=4318 /tmp/kaname-bun/node_modules/.bin/bun src/bun/kaname.ts'
```

これにより公開 Host を再び拒否し、既存の localhost 接続だけを許可する。`~/.config/kaname/kaname.env` の公開 origin の行も取り除き、後で再設定しないようにする。公開ルートを追加済みなら、Cloudflare 管理画面で `kaname.niri.la` のルートだけを削除する。既存の他のルートと Tunnel 自体は変更しない。

公開停止のために DB をバックアップへ戻す必要はない。現在のタスク、実行履歴、認証情報をそのまま使用する。
