import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { GoogleGenAI } from '@google/genai';

const app = express();
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const ALBY_API_KEY = process.env.ALBY_API_KEY;

// 1. Root route to prevent the ugly "Cannot GET /" message
app.get('/', (req, res) => {
  res.status(200).json({ 
    status: "online", 
    message: "The Autonomous L402 Tollbooth is awake. Use /api/scrape?url=YOUR_URL to interact." 
  });
});

app.get('/api/scrape', async (req, res) => {
  const targetUrl = req.query.url;
  
  if (!targetUrl) {
    return res.status(400).json({ error: 'A target URL parameter is required.' });
  }

  const authHeader = req.headers.authorization;

  // Step 1: The Paywall.
  if (!authHeader || !authHeader.startsWith('L402 ')) {
    try {
      // Explicit parameters matching current Alby spec
      const invoiceReq = await axios.post('https://api.getalby.com/invoices', {
        amount: 50, // 50 Satoshis
        memo: `L402 Data Extraction: ${targetUrl.substring(0, 30)}`
      }, {
        headers: { 
          'Authorization': `Bearer ${ALBY_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      const { payment_hash, payment_request } = invoiceReq.data;
      
      res.set('WWW-Authenticate', `L402 token="${payment_hash}", invoice="${payment_request}"`);
      return res.status(402).json({ 
        error: 'Payment Required.', 
        invoice: payment_request 
      });
    } catch (err) {
      // Log error internally in Vercel to inspect later if needed
      console.error(err.response?.data || err.message);
      return res.status(500).json({ error: 'Alby node connection failure. Verify your ALBY_API_KEY.' });
    }
  }

  // Step 2: Verification.
  try {
    const tokenParts = authHeader.replace('L402 ', '').split(':');
    const paymentHash = tokenParts[0].trim();
    
    const verifyReq = await axios.get(`https://api.getalby.com/invoices/${paymentHash}`, {
      headers: { 'Authorization': `Bearer ${ALBY_API_KEY}` }
    });

    // Check Alby's current settled field state
    if (verifyReq.data.settled !== true && verifyReq.data.state !== 'SETTLED') {
      return res.status(402).json({ error: 'Invoice remains unpaid.' });
    }

    // Step 3: Execution.
    const { data: htmlData } = await axios.get(targetUrl);
    const $ = cheerio.load(htmlData);
    const rawText = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 10000);

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Extract the core data from this raw text into a clean JSON structure: ${rawText}`
    });

    return res.status(200).json({ success: true, data: response.text });

  } catch (error) {
    return res.status(500).json({ error: 'Extraction failed, Satoshis secured.' });
  }
});

export default app;
