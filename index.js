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

// ALTERAÇÃO SEGURA: Agora busca TODOS os clientes se passar de 100
app.get('/api/clients', async (req, res) => {
    try {
        let clients = [];
        let hasMore = true;
        let startCursor = undefined;

        while (hasMore) {
            const response = await notion.databases.query({ 
                database_id: CLIENTS_DB_ID,
                start_cursor: startCursor,
                page_size: 100,
                sorts: [{ property: 'Nome', direction: 'ascending' }] 
            });
            
            const pageClients = response.results.map(page => ({
                id: page.id,
                name: page.properties.Nome?.title[0]?.plain_text || 'Sem nome'
            }));

            clients = clients.concat(pageClients);
            hasMore = response.has_more;
            startCursor = response.next_cursor;
        }

        // Ordenação alfabética final garantida
        clients.sort((a, b) => a.name.localeCompare(b.name));
        res.json(clients);
    } catch (error) {
        console.error('Erro ao buscar clientes:', error.body || error);
        res.status(500).json({ error: 'Falha ao obter clientes do Notion.' });
    }
});

// ALTERAÇÃO SEGURA: Agora busca TODAS as demandas se passar de 100
app.get('/api/demands', async (req, res) => {
    try {
        let demands = [];
        let hasMore = true;
        let startCursor = undefined;

        while (hasMore) {
            const response = await notion.databases.query({ 
                database_id: DEMANDS_DB_ID,
                start_cursor: startCursor,
                page_size: 100,
                sorts: [{ property: 'Nome da Demanda', direction: 'ascending' }] 
            });
            
            const pageDemands = response.results.map(page => ({
                id: page.id,
                name: page.properties['Nome da Demanda']?.title[0]?.plain_text || 'Sem nome',
                clientId: page.properties.Cliente?.relation[0]?.id || null
            }));

            demands = demands.concat(pageDemands);
            hasMore = response.has_more;
            startCursor = response.next_cursor;
        }

        // Ordenação alfabética final garantida
        demands.sort((a, b) => a.name.localeCompare(b.name));
        res.json(demands);
    } catch (error) {
        console.error('Erro ao buscar demandas:', error.body || error);
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

app.post('/api/generate-report', async (req, res) => {
    const { clientId, clientName } = req.body;
    
    if (!sheets) {
        return res.status(500).json({ error: 'Integração com Google Sheets não configurada no servidor.' });
    }

    try {
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

        const demandIdFilters = clientDemands.map(demand => ({
            property: 'Demanda',
            relation: { contains: demand.id }
        }));

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

        const reportData = timeEntriesResponse.results
            .map(page => {
                if (!page.properties.Demanda?.relation || page.properties.Demanda.relation.length === 0) {
                    return null;
                }
                const demandRelation = page.properties.Demanda.relation[0];
                const demandInfo = clientDemands.find(d => d.id === demandRelation.id);
                
                return {
                    demandName: demandInfo ? demandInfo.name : 'Demanda Desconhecida',
                    duration: page.properties.Duração?.number || 0
                };
            })
            .filter(Boolean);

        if (reportData.length === 0) {
            return res.status(200).json({ message: `Nenhum registro de tempo na última semana para ${clientName}.` });
        }
        
        const aggregatedData = reportData.reduce((acc, entry) => {
            acc[entry.demandName] = (acc[entry.demandName] || 0) + entry.duration;
            return acc;
        }, {});

        // Converte as horas para o formato hh:mm:ss
        const formattedEntries = Object.entries(aggregatedData).map(([demand, hours]) => {
            const totalSeconds = Math.floor(hours * 3600);
            const h = Math.floor(totalSeconds / 3600);
            const m = Math.floor((totalSeconds % 3600) / 60);
            const s = totalSeconds % 60;
            return [demand, `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`];
        });

        const sheetData = [['Demanda', 'Horas'], ...formattedEntries];
        
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
        res.status(200).json({ message: 'Planilha updated com sucesso!', sheetUrl });

    } catch (error) {
        console.error('Erro ao gerar relatório:', error.response ? error.response.data : error.body);
        res.status(500).json({ error: 'Falha ao gerar relatório.' });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
