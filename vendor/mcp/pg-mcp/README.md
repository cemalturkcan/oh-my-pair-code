# PostgreSQL MCP Server (stdio)

Bu proje, PostgreSQL icin basit bir MCP sunucusu saglar. Iletisim `stdio` uzerinden yapilir ve sorgular salt-okunur sekilde calisir.

## Ozellikler

- `config.json` ile birden fazla baglanti tanimi
- MCP araclari:
  - `list_connections`
  - `list_databases`
  - `list_schemas`
  - `list_tables`
  - `describe_table`
  - `execute_select`
- Istege bagli `database` parametresi ile tek baglanti uzerinden farkli DB'leri gezebilme
- Guvenlik kurallari:
  - Yalnizca `SELECT` sorgulari
  - Coklu statement reddi
  - Yazma/DDL anahtar kelimeleri reddi
  - Read-only transaction
  - `statement_timeout` zorlamasi
  - Baglanti bazli satir limiti (`default_row_limit` / `max_row_limit`)

## Kurulum

```bash
npm install
```

## Yapilandirma

1. Ornek dosyayi kopyalayin:

```bash
cp config.example.json config.json
```

2. `config.json` icindeki baglanti bilgilerini guncelleyin.

Notlar:
- Gercek `config.json` dosyasi `.gitignore` ile dislanmistir.
- Dilerseniz farkli bir yol kullanmak icin `PG_MCP_CONFIG_PATH` degiskenini ayarlayabilirsiniz.

## Calistirma

```bash
npm start
```

## Ornek MCP istemci ayari

Asagidaki ornek, MCP istemci konfigine bu sunucuyu eklemek icindir:

```json
{
  "mcpServers": {
    "pg": {
      "command": "node",
      "args": ["/absolute/path/to/pg-mcp/src/index.js"],
      "env": {
        "PG_MCP_CONFIG_PATH": "/absolute/path/to/pg-mcp/config.json"
      }
    }
  }
}
```

## Baglanti ayari (ornek)

```json
{
  "connections": {
    "local": {
      "host": "127.0.0.1",
      "port": 5432,
      "user": "readonly_user",
      "password": "readonly_password",
      "database": "postgres",
      "description": "Root baglanti (DB listesi icin)",
      "statement_timeout_ms": 10000,
      "default_row_limit": 100,
      "max_row_limit": 1000
    }
  }
}
```

## DB gezme akisi

1. `list_databases` ile erisilebilir DB'leri alin.
2. `list_schemas` / `list_tables` / `describe_table` / `execute_select` cagrilarinda `database` parametresi gonderin.
