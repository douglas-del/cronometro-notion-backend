// Servidor para o App de Cronômetro Notion, otimizado para a Render

const express = require('express');
const { Client } = require('@notionhq/client');
const { google } = require('googleapis');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- Configuração das Chaves (lidas das variáveis de ambiente da Render) ---
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const CLIENTS_DB_ID = process.env.CLIENTS_DB_ID;
const DEMANDS_DB_ID = process.env.DEMANDS_DB_ID;
const TIME_LOG_DB_ID = process.env.TIME_LOG_DB_ID;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');


// --- Lógica do Google Sheets ---
let sheets;
if (GOOGLE_CLIENT_EMAIL && GOOGLE_PRIVATE_KEY) {
    const auth = new google.auth.GoogleAuth({
        credentials: {
          client_email: GOOGLE_CLIENT_EMAIL,
          private_key: GOOGLE_PRIVATE_KEY,
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheets = google.sheets({ version: 'v4', auth });
}


// --- Endpoints da API ---

app.get('/', (req, res) => {
  res.send('Servidor do Cronômetro Notion está no ar!');
});

app.get('/api/clients', async (req, res) => {
    try {
        const response = await notion.databases.query({ database_id: CLIENTS_DB_ID, sorts: [{ property: 'Nome', direction: 'ascending' }] });
        const clients = response.results.map(page => ({
            id: page.id,
            name: page.properties.Nome?.title[0]?.plain_text || 'Sem nome'
        }));
        res.json(clients);
    } catch (error) {
        console.error('Erro ao buscar clientes:', error.body);
        res.status(500).json({ error: 'Falha ao obter clientes do Notion.' });
    }
});

app.get('/api/demands', async (req, res) => {
    try {
        const response = await notion.databases.query({ database_id: DEMANDS_DB_ID, sorts: [{ property: 'Nome da Demanda', direction: 'ascending' }] });
        const demands = response.results.map(page => ({
            id: page.id,
            name: page.properties['Nome da Demanda']?.title[0]?.plain_text || 'Sem nome',
            clientId: page.properties.Cliente?.relation[0]?.id || null
        }));
        res.json(demands);
    } catch (error) {
        console.error('Erro ao buscar demandas:', error.body);
        res.status(500).json({ error: 'Falha ao obter demandas do Notion.' });
    }
});

app.post('/api/demands', async (req, res) => {
    const { clientId, demandName } = req.body;
    try {
        const response = await notion.pages.create({
            parent: { database_id: DEMANDS_DB_ID },
            properties: {
                'Nome da Demanda': { title: [{ text: { content: demandName } }] },
                'Cliente': { relation: [{ id: clientId }] }
            }
        });
        res.status(201).json({ 
            id: response.id,
            name: demandName,
            clientId: clientId
        });
    } catch (error) {
        console.error('Erro ao criar demanda:', error.body);
        res.status(500).json({ error: 'Falha ao criar demanda no Notion.' });
    }
});

app.post('/api/time-entries', async (req, res) => {
    const { demandId, durationSeconds } = req.body;
    const durationHours = durationSeconds / 3600;

    try {
        const response = await notion.pages.create({
            parent: { database_id: TIME_LOG_DB_ID },
            properties: {
                'Tarefa': { title: [{ text: { content: `Registro de ${new Date().toLocaleDateString('pt-BR')}` } }] },
                'Demanda': { relation: [{ id: demandId }] },
                'Duração': { number: parseFloat(durationHours.toFixed(4)) },
                'Data': { date: { start: new Date().toISOString() } }
            }
        });
        res.status(201).json(response);
    } catch (error) {
        console.error('Erro ao criar registro de tempo:', error.body);
        res.status(500).json({ error: 'Falha ao criar registro de tempo no Notion.' });
    }
});

// **FUNÇÃO DE RELATÓRIO CORRIGIDA - SEM DEPENDÊNCIA DE ROLLUPS**
app.post('/api/generate-report', async (req, res) => {
    const { clientId, clientName } = req.body;
    
    if (!sheets) {
        return res.status(500).json({ error: 'Integração com Google Sheets não configurada no servidor.' });
    }

    try {
        // Passo 1: Encontrar todas as demandas associadas ao cliente selecionado.
        const demandsResponse = await notion.databases.query({
            database_id: DEMANDS_DB_ID,
            filter: {
                property: 'Cliente',
                relation: { contains: clientId }
            }
        });

        const clientDemands = demandsResponse.results.map(page => ({
            id: page.id,
            name: page.properties['Nome da Demanda']?.title[0]?.plain_text || 'Demanda Sem Nome'
        }));

        if (clientDemands.length === 0) {
            return res.status(200).json({ message: `Nenhuma demanda encontrada para o cliente ${clientName}.` });
        }

        // Passo 2: Criar um filtro para buscar todos os registros de tempo dessas demandas.
        const demandIdFilters = clientDemands.map(demand => ({
            property: 'Demanda',
            relation: { contains: demand.id }
        }));

        // Passo 3: Buscar os registros de tempo da última semana que correspondem a qualquer uma das demandas do cliente.
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const timeEntriesResponse = await notion.databases.query({
            database_id: TIME_LOG_DB_ID,
            filter: {
                and: [
                    { property: 'Data', date: { on_or_after: oneWeekAgo } },
                    { or: demandIdFilters }
                ]
            }
        });

        // Passo 4: Mapear os resultados para obter o nome da demanda e a duração.
        const reportData = timeEntriesResponse.results.map(page => {
            const demandRelation = page.properties.Demanda.relation[0];
            const demandInfo = clientDemands.find(d => d.id === demandRelation.id);
            return {
                demandName: demandInfo ? demandInfo.name : 'Demanda Desconhecida',
                duration: page.properties.Duração?.number || 0
            };
        });

        if (reportData.length === 0) {
            return res.status(200).json({ message: `Nenhum registro de tempo na última semana para ${clientName}.` });
        }
        
        // Passo 5: Agregar os dados e formatar para a planilha.
        const aggregatedData = reportData.reduce((acc, entry) => {
            acc[entry.demandName] = (acc[entry.demandName] || 0) + entry.duration;
            return acc;
        }, {});

        const sheetData = [['Demanda', 'Horas'], ...Object.entries(aggregatedData)];
        
        // Passo 6: Escrever os dados no Google Sheets.
        const spreadsheetId = GOOGLE_SHEET_ID;
        const sheetName = clientName;

        const sheetsMetadata = await sheets.spreadsheets.get({ spreadsheetId });
        const sheetExists = sheetsMetadata.data.sheets.some(s => s.properties.title === sheetName);

        if (!sheetExists) {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] }
            });
        }
        
        await sheets.spreadsheets.values.clear({ spreadsheetId, range: sheetName });
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${sheetName}!A1`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: sheetData }
        });

        const sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
        res.status(200).json({ message: 'Planilha atualizada com sucesso!', sheetUrl });

    } catch (error) {
        console.error('Erro ao gerar relatório:', error.response ? error.response.data : error.body);
        res.status(500).json({ error: 'Falha ao gerar relatório.' });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});

