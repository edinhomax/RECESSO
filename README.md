# Recesso

Sistema de gestão de férias e ausências de funcionários, desenvolvido em Python (Flask) com banco de dados SQLite.

## Funcionalidades
- Cadastro de funcionários
- Controle de férias e folgas por período, com motivo
- Login administrativo
- Geração automática de documento de autorização em PDF (via impressão do navegador) para assinatura do funcionário
- Exportação de relatórios em Excel (CSV)

## Como rodar localmente
```
pip install -r requirements.txt
python app.py
```
O programa também pode ser empacotado como executável standalone para Windows com PyInstaller — veja `LEIA-ME.txt`.

## Tecnologias
Python, Flask, SQLite, HTML/CSS/JavaScript
