# Publicar o Dashboard em uma porta

## No GitHub Codespaces
1. Deixe `index.html`, `main.css` e `script.js` na mesma pasta.
2. Execute:

```bash
python3 -m http.server 8080 --bind 0.0.0.0
```

3. Abra **PORTS**, localize a porta **8080** e altere a visibilidade para **Public**.
4. Copie a URL HTTPS pública fornecida pelo Codespaces.

Essa URL será o endereço que qualquer usuário poderá abrir.

## ESP32
O dashboard continua funcionando em modo de simulação quando nenhum IP do ESP32 é configurado. Para dados reais, informe o endereço do ESP32 nas configurações.
