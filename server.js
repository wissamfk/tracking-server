const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Tracking Contenedores Proxy Server',
    endpoints: [
      'GET /api/track/:carrier/:number',
      'POST /api/track-bulk'
    ]
  });
});

// ═══════════════════════════════════════
// HEADERS COMUNES PARA SIMULAR NAVEGADOR
// ═══════════════════════════════════════
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
};

// ═══════════════════════════════════════
// SCRAPERS POR NAVIERA
// ═══════════════════════════════════════

// ─── MSC ───
async function trackMSC(number) {
  try {
    // MSC tiene una API interna que podemos consultar
    const resp = await axios.get(
      `https://www.msc.com/api/feature/tools/TrackingInfo?trackingNumber=${encodeURIComponent(number)}&trackingType=CONTAINER`,
      {
        headers: {
          ...BROWSER_HEADERS,
          'Accept': 'application/json',
          'Referer': 'https://www.msc.com/track-a-shipment',
        },
        timeout: 15000,
      }
    );
    
    if (resp.data) {
      const data = resp.data;
      // Intentar extraer datos según la estructura de MSC
      return {
        carrier: 'MSC',
        number,
        success: true,
        raw: data,
        trackingUrl: `https://www.msc.com/track-a-shipment?trackingNumber=${number}`,
      };
    }
  } catch (e) {
    // Fallback: scraping HTML
    try {
      const resp = await axios.get(
        `https://www.msc.com/track-a-shipment?trackingNumber=${encodeURIComponent(number)}`,
        { headers: BROWSER_HEADERS, timeout: 15000 }
      );
      const $ = cheerio.load(resp.data);
      return {
        carrier: 'MSC',
        number,
        success: true,
        message: 'Página cargada, datos disponibles en portal',
        trackingUrl: `https://www.msc.com/track-a-shipment?trackingNumber=${number}`,
        htmlAvailable: true,
      };
    } catch (e2) {
      return { carrier: 'MSC', number, success: false, error: e2.message };
    }
  }
}

// ─── MAERSK ───
async function trackMaersk(number) {
  try {
    // Maersk tiene una API pública de tracking
    const resp = await axios.get(
      `https://api.maersk.com/track/${encodeURIComponent(number)}`,
      {
        headers: {
          ...BROWSER_HEADERS,
          'Accept': 'application/json',
          'Consumer-Key': 'your-consumer-key', // Maersk requiere API key
        },
        timeout: 15000,
      }
    );
    return { carrier: 'Maersk', number, success: true, raw: resp.data };
  } catch (e) {
    // Fallback: intentar scraping
    try {
      const resp = await axios.get(
        `https://www.maersk.com/tracking/${encodeURIComponent(number)}`,
        { headers: BROWSER_HEADERS, timeout: 15000 }
      );
      
      const $ = cheerio.load(resp.data);
      
      // Buscar datos en el HTML o scripts embebidos
      const scripts = $('script').map((i, el) => $(el).html()).get();
      let trackingData = null;
      
      for (const script of scripts) {
        if (script && (script.includes('trackingData') || script.includes('shipmentInfo'))) {
          try {
            const match = script.match(/window\.__INITIAL_STATE__\s*=\s*({.*?});/s);
            if (match) trackingData = JSON.parse(match[1]);
          } catch {}
        }
      }
      
      return {
        carrier: 'Maersk',
        number,
        success: true,
        raw: trackingData,
        trackingUrl: `https://www.maersk.com/tracking/${number}`,
      };
    } catch (e2) {
      return { carrier: 'Maersk', number, success: false, error: e2.message };
    }
  }
}

// ─── CMA CGM ───
async function trackCMACGM(number) {
  try {
    const resp = await axios.get(
      `https://www.cma-cgm.com/api/tracing/tracking?reference=${encodeURIComponent(number)}`,
      {
        headers: {
          ...BROWSER_HEADERS,
          'Accept': 'application/json',
          'Referer': 'https://www.cma-cgm.com/ebusiness/tracking',
        },
        timeout: 15000,
      }
    );
    return { carrier: 'CMA CGM', number, success: true, raw: resp.data };
  } catch (e) {
    return {
      carrier: 'CMA CGM',
      number,
      success: false,
      error: e.message,
      trackingUrl: `https://www.cma-cgm.com/ebusiness/tracking/search?Reference=${number}`,
    };
  }
}

// ─── HAPAG-LLOYD ───
async function trackHapagLloyd(number) {
  try {
    const resp = await axios.get(
      `https://www.hapag-lloyd.com/en/online-business/track/track-by-container-solution.html?container=${encodeURIComponent(number)}`,
      { headers: BROWSER_HEADERS, timeout: 15000 }
    );
    const $ = cheerio.load(resp.data);
    return {
      carrier: 'Hapag-Lloyd',
      number,
      success: true,
      trackingUrl: `https://www.hapag-lloyd.com/en/online-business/track/track-by-container-solution.html?container=${number}`,
    };
  } catch (e) {
    return { carrier: 'Hapag-Lloyd', number, success: false, error: e.message };
  }
}

// ─── COSCO ───
async function trackCOSCO(number) {
  try {
    const resp = await axios.post(
      'https://elines.coscoshipping.com/ebtracking/public/containers/search',
      { number: number },
      {
        headers: {
          ...BROWSER_HEADERS,
          'Content-Type': 'application/json',
          'Referer': 'https://elines.coscoshipping.com/ebusiness/cargotracking',
        },
        timeout: 15000,
      }
    );
    return { carrier: 'COSCO', number, success: true, raw: resp.data };
  } catch (e) {
    return {
      carrier: 'COSCO',
      number,
      success: false,
      error: e.message,
      trackingUrl: `https://elines.coscoshipping.com/ebusiness/cargotracking?number=${number}`,
    };
  }
}

// ─── ZIM ───
async function trackZIM(number) {
  try {
    const resp = await axios.get(
      `https://www.zim.com/api/tracking?consnumber=${encodeURIComponent(number)}`,
      {
        headers: {
          ...BROWSER_HEADERS,
          'Accept': 'application/json',
          'Referer': 'https://www.zim.com/tools/track-a-shipment',
        },
        timeout: 15000,
      }
    );
    return { carrier: 'ZIM', number, success: true, raw: resp.data };
  } catch (e) {
    return {
      carrier: 'ZIM',
      number,
      success: false,
      error: e.message,
      trackingUrl: `https://www.zim.com/tools/track-a-shipment?consnumber=${number}`,
    };
  }
}

// ─── ONE ───
async function trackONE(number) {
  try {
    const resp = await axios.get(
      `https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking?regos-tracking-number=${encodeURIComponent(number)}`,
      { headers: BROWSER_HEADERS, timeout: 15000 }
    );
    return {
      carrier: 'ONE',
      number,
      success: true,
      trackingUrl: `https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking?regos-tracking-number=${number}`,
    };
  } catch (e) {
    return { carrier: 'ONE', number, success: false, error: e.message };
  }
}

// ─── EVERGREEN ───
async function trackEvergreen(number) {
  try {
    const resp = await axios.get(
      `https://www.shipmentlink.com/servlet/TDB1_CargoTracking.do?BolsLst=${encodeURIComponent(number)}`,
      { headers: BROWSER_HEADERS, timeout: 15000 }
    );
    const $ = cheerio.load(resp.data);
    
    // Extraer tabla de tracking
    const events = [];
    $('table.tbl_Hispowerful tr').each((i, row) => {
      if (i === 0) return; // skip header
      const cols = $(row).find('td');
      if (cols.length >= 4) {
        events.push({
          date: $(cols[0]).text().trim(),
          location: $(cols[1]).text().trim(),
          description: $(cols[2]).text().trim(),
          vessel: $(cols[3]).text().trim(),
        });
      }
    });
    
    return {
      carrier: 'Evergreen',
      number,
      success: true,
      events: events.length ? events : null,
      trackingUrl: `https://www.shipmentlink.com/servlet/TDB1_CargoTracking.do?BolsLst=${number}`,
    };
  } catch (e) {
    return { carrier: 'Evergreen', number, success: false, error: e.message };
  }
}

// ─── YANG MING ───
async function trackYangMing(number) {
  try {
    const resp = await axios.get(
      `https://www.yangming.com/e-service/track_trace/track_trace_cargo_tracking.aspx?search=${encodeURIComponent(number)}`,
      { headers: BROWSER_HEADERS, timeout: 15000 }
    );
    return {
      carrier: 'Yang Ming',
      number,
      success: true,
      trackingUrl: `https://www.yangming.com/e-service/track_trace/track_trace_cargo_tracking.aspx?search=${number}`,
    };
  } catch (e) {
    return { carrier: 'Yang Ming', number, success: false, error: e.message };
  }
}

// ─── TRACK-TRACE.COM (servicio universal) ───
async function trackGeneric(number) {
  try {
    const resp = await axios.get(
      `https://www.track-trace.com/container?number=${encodeURIComponent(number)}`,
      { headers: BROWSER_HEADERS, timeout: 15000 }
    );
    const $ = cheerio.load(resp.data);
    
    // Track-trace.com muestra info del contenedor
    const info = {};
    
    // Intentar detectar la naviera
    const carrierText = $('body').text();
    const carriers = ['MSC', 'Maersk', 'CMA CGM', 'Hapag-Lloyd', 'COSCO', 'Evergreen', 'ONE', 'ZIM', 'Yang Ming'];
    for (const c of carriers) {
      if (carrierText.includes(c)) {
        info.detectedCarrier = c;
        break;
      }
    }
    
    return {
      carrier: 'Track-Trace',
      number,
      success: true,
      info,
      trackingUrl: `https://www.track-trace.com/container?number=${number}`,
    };
  } catch (e) {
    return { carrier: 'Track-Trace', number, success: false, error: e.message };
  }
}

// ═══════════════════════════════════════
// MAP DE SCRAPERS
// ═══════════════════════════════════════
const SCRAPERS = {
  'MSC': trackMSC,
  'Maersk': trackMaersk,
  'CMA CGM': trackCMACGM,
  'Hapag-Lloyd': trackHapagLloyd,
  'COSCO': trackCOSCO,
  'ZIM': trackZIM,
  'ONE': trackONE,
  'Evergreen': trackEvergreen,
  'Yang Ming': trackYangMing,
};

// ═══════════════════════════════════════
// ENDPOINT: Rastrear un contenedor
// ═══════════════════════════════════════
app.get('/api/track/:carrier/:number', async (req, res) => {
  const { carrier, number } = req.params;
  
  try {
    const scraper = SCRAPERS[carrier];
    if (scraper) {
      const result = await scraper(number);
      return res.json(result);
    }
    
    // Si no hay scraper específico, usar Track-Trace
    const result = await trackGeneric(number);
    return res.json(result);
  } catch (e) {
    return res.json({ carrier, number, success: false, error: e.message });
  }
});

// ═══════════════════════════════════════
// ENDPOINT: Auto-detectar naviera
// ═══════════════════════════════════════
app.get('/api/detect/:number', async (req, res) => {
  const { number } = req.params;
  
  // Detección por prefijo del contenedor
  const prefix = number.substring(0, 4).toUpperCase();
  const prefixMap = {
    'MSCU': 'MSC', 'MEDU': 'MSC', 'MSMU': 'MSC',
    'MAEU': 'Maersk', 'MSKU': 'Maersk', 'MRKU': 'Maersk', 'MRSU': 'Maersk',
    'CMAU': 'CMA CGM', 'CGMU': 'CMA CGM',
    'HLBU': 'Hapag-Lloyd', 'HLCU': 'Hapag-Lloyd', 'HLXU': 'Hapag-Lloyd',
    'CCLU': 'COSCO', 'CSNU': 'COSCO', 'CSQU': 'COSCO', 'CBHU': 'COSCO',
    'EISU': 'Evergreen', 'EGHU': 'Evergreen', 'EMCU': 'Evergreen', 'EITU': 'Evergreen',
    'ONEY': 'ONE', 'ONEU': 'ONE',
    'YMLU': 'Yang Ming', 'YMMU': 'Yang Ming',
    'ZIMU': 'ZIM', 'ZCSU': 'ZIM',
  };
  
  const detected = prefixMap[prefix] || null;
  
  if (detected && SCRAPERS[detected]) {
    try {
      const result = await SCRAPERS[detected](number);
      return res.json({ ...result, detectedCarrier: detected });
    } catch (e) {
      return res.json({ number, detectedCarrier: detected, success: false, error: e.message });
    }
  }
  
  // Si no detectamos, intentar Track-Trace
  const result = await trackGeneric(number);
  return res.json({ ...result, detectedCarrier: detected });
});

// ═══════════════════════════════════════
// ENDPOINT: Rastrear múltiples
// ═══════════════════════════════════════
app.post('/api/track-bulk', async (req, res) => {
  const { containers } = req.body;
  // containers = [{ number: 'MSCU123', carrier: 'MSC' }, ...]
  
  if (!containers || !Array.isArray(containers)) {
    return res.status(400).json({ error: 'Se requiere un array de containers' });
  }
  
  const results = await Promise.allSettled(
    containers.map(async (c) => {
      const scraper = SCRAPERS[c.carrier];
      if (scraper) return scraper(c.number);
      return trackGeneric(c.number);
    })
  );
  
  const data = results.map((r, i) => ({
    ...containers[i],
    result: r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message },
  }));
  
  res.json({ results: data });
});

// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🚢 Tracking Proxy Server corriendo en http://localhost:${PORT}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /api/track/:carrier/:number  - Rastrear un contenedor`);
  console.log(`  GET  /api/detect/:number           - Auto-detectar naviera`);
  console.log(`  POST /api/track-bulk               - Rastrear múltiples\n`);
});
