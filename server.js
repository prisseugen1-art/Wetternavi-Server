import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// CORS erlaubt deiner Flutter-App den Zugriff
app.use(cors());
app.use(express.json());

/**
 * Endpunkt für deine Flutter-App:
 * Ruft die Retell-API auf und gibt den access_token zurück
 */
app.post('/api/create-web-call', async (req, res) => {
  try {
    // ⚠️ DEINE AGENT-ID HIER EINTRAGEN!
    const agentId = 'agent_a057b329f51908e22b75bbf2e4';

    console.log('📤 Erstelle Web Call für Agent:', agentId);

    // Retell API aufrufen
    const response = await fetch('https://api.retellai.com/v2/create-web-call', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RETELL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: agentId,
        retell_llm_dynamic_variables: {
          customer_name: req.body.customerName || 'Gast',
          location: req.body.location || 'Berlin',
        },
        metadata: {
          user_id: req.body.userId || 'unknown',
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Retell API Fehler:', response.status, errorText);
      return res.status(500).json({
        error: 'Failed to create web call',
        details: errorText,
      });
    }

    const call = await response.json();
    console.log('✅ Web Call erstellt:', call.call_id);

    res.json({
      accessToken: call.access_token,
      callId: call.call_id,
    });
  } catch (error) {
    console.error('❌ Server-Fehler:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Server starten
app.listen(PORT, () => {
  console.log(`🚀 Server läuft auf http://0.0.0.0.:${PORT}`);
});