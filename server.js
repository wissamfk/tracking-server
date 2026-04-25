const express = require('express');
const cors = require('cors');
const axios = require('axios');
const qs = require('querystring');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════
// 🔑 SHIPSGO API
// ═══════════════════════════════════════
const AUTH = process.env.SHIPSGO_KEY || '284e7774-a60b-4b56-b389-44705cf3a058';
const BASE = 'https://shipsgo.com/api/v1.2/ContainerService';

// Carrier name mapping for ShipsGo
const CARRIER_MAP = {
  'MSC': 'MSC', 'Maersk': 'MAERSK LINE', 'CMA CGM': 'CMA CGM',
  'Hapag-Lloyd': 'HAPAG LLOYD', 'COSCO': 'COSCO', 'Evergreen': 'EVERGREEN',
  'ONE': 'ONE', 'Yang Ming': 'YANG MING', 'ZIM': 'ZIM',
};

// Prefix detection
const PREFIX = {
  MSCU:'MSC',MEDU:'MSC',MSMU:'MSC',
  MAEU:'MAERSK LINE',MSKU:'MAERSK LINE',MRKU:'MAERSK LINE',
  CMAU:'CMA CGM',CGMU:'CMA CGM',
  HLBU:'HAPAG LLOYD',HLCU:'HAPAG LLOYD',HLXU:'HAPAG LLOYD',
  CCLU:'COSCO',CSNU:'COSCO',CSQU:'COSCO',CBHU:'COSCO',
  EISU:'EVERGREEN',EGHU:'EVERGREEN',EMCU:'EVERGREEN',
  ONEY:'ONE',ONEU:'ONE',
  YMLU:'YANG MING',YMMU:'YANG MING',
  ZIMU:'ZIM',ZCSU:'ZIM',
};

// Reverse map for display names
const DISPLAY_NAME = {
  'MSC':'MSC','MAERSK LINE':'Maersk','CMA CGM':'CMA CGM',
  'HAPAG LLOYD':'Hapag-Lloyd','COSCO':'COSCO','EVERGREEN':'Evergreen',
  'ONE':'ONE','YANG MING':'Yang Ming','ZIM':'ZIM',
};

app.get('/', (req, res) => res.json({ status: 'ok', service: 'ShipsGo Proxy', credits: 'check dashboard' }));

// ═══════════════════════════════════════
// POST /api/track — Track a container or BL
// ═══════════════════════════════════════
app.post('/api/track', async (req, res) => {
  const { number, carrier } = req.body;
  if (!number) return res.status(400).json({ success: false, error: 'Número requerido' });

  const num = number.trim().toUpperCase();
  const isContainer = /^[A-Z]{4}\d{7,}$/.test(num);

  // Detect shipping line
  let shippingLine = 'OTHERS';
  if (carrier && CARRIER_MAP[carrier]) {
    shippingLine = CARRIER_MAP[carrier];
  } else if (isContainer) {
    const pfx = num.substring(0, 4);
    if (PREFIX[pfx]) shippingLine = PREFIX[pfx];
  }

  try {
    // Step 1: POST to create tracking request
    let postUrl, postData;

    if (isContainer) {
      // Container number tracking
      postUrl = `${BASE}/PostContainerInfo`;
      postData = qs.stringify({
        authCode: AUTH,
        containerNumber: num,
        shippingLine: shippingLine,
      });
    } else {
      // BL number tracking
      postUrl = `${BASE}/PostBLContainerInfo`;
      postData = qs.stringify({
        authCode: AUTH,
        blContainersRef: num,
        shippingLine: shippingLine,
      });
    }

    let requestId = null;
    try {
      const postResp = await axios.post(postUrl, postData, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      });
      console.log('POST raw response:', JSON.stringify(postResp.data));
      // Response could be: number, {RequestId: n}, or string
      if (postResp.data && postResp.data.RequestId) {
        requestId = postResp.data.RequestId;
      } else if (typeof postResp.data === 'object' && postResp.data.requestId) {
        requestId = postResp.data.requestId;
      } else if (typeof postResp.data === 'number') {
        requestId = postResp.data;
      } else if (typeof postResp.data === 'string') {
        var parsed = parseInt(postResp.data.replace(/"/g,''));
        if (!isNaN(parsed)) requestId = parsed;
      }
      console.log('Extracted requestId:', requestId);
    } catch (postErr) {
      const errData = postErr.response?.data;
      console.log('POST error:', JSON.stringify(errData));
      // Check if error contains a requestId (already tracked)
      if (errData && errData.RequestId) requestId = errData.RequestId;
    }

    // Step 2: Wait then GET voyage data
    // Try with requestId first (from POST), then with the number
    await sleep(4000);

    const idsToTry = [];
    if (requestId) idsToTry.push(requestId);
    idsToTry.push(num);

    let data = null;
    for (const rid of idsToTry) {
      try {
        const getUrl = `${BASE}/GetContainerInfo?authCode=${AUTH}&requestId=${encodeURIComponent(rid)}&mapPoint=true`;
        console.log('GET attempt with:', rid);
        const getResp = await axios.get(getUrl, {
          headers: { 'Accept': 'application/json' },
          timeout: 15000,
        });
        console.log('GET response type:', typeof getResp.data, Array.isArray(getResp.data) ? 'array:'+getResp.data.length : '');
        if (getResp.data && !(Array.isArray(getResp.data) && getResp.data.length === 0)) {
          // Check if it has actual data (not just empty fields)
          const d = getResp.data;
          if (d.Status || d.Pol || d.Pod || d.ShippingLine) {
            data = d;
            break;
          }
        }
      } catch (getErr) {
        console.log('GET error with', rid, ':', getErr.response?.data?.Message || getErr.message);
      }
    }

    // If still no data, wait more and retry once
    if (!data && requestId) {
      await sleep(5000);
      try {
        const retryUrl = `${BASE}/GetContainerInfo?authCode=${AUTH}&requestId=${encodeURIComponent(requestId)}&mapPoint=true`;
        console.log('Retry GET with requestId:', requestId);
        const retryResp = await axios.get(retryUrl, { headers: { 'Accept': 'application/json' }, timeout: 15000 });
        if (retryResp.data && retryResp.data.Status) data = retryResp.data;
      } catch (retryErr) {
        console.log('Retry failed:', retryErr.response?.data?.Message || retryErr.message);
      }
    }

    if (!data) {
      return res.json({
        success: true,
        number: num,
        detectedCarrier: DISPLAY_NAME[shippingLine] || shippingLine,
        status: 'processing',
        message: 'Tracking creado (ID: '+(requestId||'pendiente')+'). ShipsGo necesita unos minutos para procesar. Intenta de nuevo en 5-10 min.',
        requestId,
      });
    }

    // Parse ShipsGo response
    const parsed = parseShipsGoData(data, num, shippingLine);
    return res.json(parsed);

  } catch (err) {
    console.error('Track error:', err.response?.data || err.message);
    return res.json({
      success: false,
      number: num,
      detectedCarrier: DISPLAY_NAME[shippingLine] || shippingLine,
      error: err.response?.data?.Message || err.message,
    });
  }
});

// ═══════════════════════════════════════
// GET /api/status/:number — Get tracking status only (no credit cost)
// ═══════════════════════════════════════
app.get('/api/status/:number', async (req, res) => {
  const num = req.params.number.trim().toUpperCase();

  try {
    const getUrl = `${BASE}/GetContainerInfo?authCode=${AUTH}&requestId=${encodeURIComponent(num)}&mapPoint=true`;
    const getResp = await axios.get(getUrl, {
      headers: { 'Accept': 'application/json' },
      timeout: 15000,
    });

    const data = getResp.data;
    if (!data || (Array.isArray(data) && data.length === 0)) {
      return res.json({ success: false, message: 'Sin datos disponibles' });
    }

    const parsed = parseShipsGoData(data, num, '');
    return res.json(parsed);
  } catch (err) {
    return res.json({ success: false, error: err.response?.data?.Message || err.message });
  }
});

// ═══════════════════════════════════════
// GET /api/carriers — List supported carriers
// ═══════════════════════════════════════
app.get('/api/carriers', async (req, res) => {
  try {
    const resp = await axios.get(`${BASE}/GetShippingLineList?authCode=${AUTH}`, {
      headers: { 'Accept': 'application/json' },
      timeout: 10000,
    });
    res.json({ success: true, carriers: resp.data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════
// PARSE SHIPSGO DATA (actual format)
// ═══════════════════════════════════════
function parseShipsGoData(data, number, shippingLine) {
  let sd = data;
  if (Array.isArray(data) && data.length > 0) sd = data[0];
  if (!sd) return { success: false, number, message: 'Sin datos' };

  // Main fields from actual ShipsGo response
  const carrier = sd.ShippingLine || DISPLAY_NAME[shippingLine] || shippingLine || '';
  const containerNum = sd.ContainerNumber || number;
  const containerType = sd.ContainerType || '';
  const containerTEU = sd.ContainerTEU || '';
  const bl = sd.BLReferenceNo || '';
  const status = sd.Status || '';
  const fromCountry = sd.FromCountry || '';
  const toCountry = sd.ToCountry || '';
  const pol = sd.Pol || '';
  const pod = sd.Pod || '';

  // Dates
  const departureDate = sd.DepartureDate ? sd.DepartureDate.Date || '' : '';
  const loadingDate = sd.LoadingDate ? sd.LoadingDate.Date || '' : '';
  const arrivalDate = sd.ArrivalDate ? sd.ArrivalDate.Date || '' : '';
  const dischargeDate = sd.DischargeDate ? sd.DischargeDate.Date || '' : '';
  const emptyToShipperDate = sd.EmptyToShipperDate || '';
  const gateInDate = sd.GateInDate || '';
  const gateOutDate = sd.GateOutDate || '';
  const eta = sd.ETA || sd.FirstETA || '';
  const firstETA = sd.FirstETA || '';
  const transitTime = sd.FormatedTransitTime || '';

  // Vessel info
  const vessel = sd.Vessel || '';
  const vesselIMO = sd.VesselIMO || '';
  const vesselVoyage = sd.VesselVoyage || '';
  const vesselLat = sd.VesselLatitude || null;
  const vesselLng = sd.VesselLongitude || null;

  // Build origin/destination strings
  const origin = pol ? `${pol}${fromCountry ? ', ' + fromCountry : ''}` : fromCountry || '';
  const destination = pod ? `${pod}${toCountry ? ', ' + toCountry : ''}` : toCountry || '';

  // Transhipment ports & events
  const tsPorts = sd.TSPorts || [];
  const events = [];

  // Add main events from dates
  if (emptyToShipperDate) events.push({ date: emptyToShipperDate, description: 'Empty to Shipper', location: pol || fromCountry || '' });
  if (gateInDate) events.push({ date: gateInDate, description: 'Gate In', location: pol || '' });
  if (loadingDate) events.push({ date: loadingDate, description: 'Loaded on Vessel', location: pol || '', vessel: '' });
  if (departureDate) events.push({ date: departureDate, description: 'Departed', location: pol || '', vessel: '' });

  // Add transhipment port events
  if (Array.isArray(tsPorts)) {
    tsPorts.forEach(ts => {
      const port = ts.Port || '';
      const tsVessel = ts.Vessel || '';
      const tsVoyage = ts.VesselVoyage || '';
      if (ts.ArrivalDate) events.push({ date: ts.ArrivalDate.Date || '', description: `Arrived at transhipment`, location: port, vessel: tsVessel });
      if (ts.DepartureDate) events.push({ date: ts.DepartureDate.Date || '', description: `Departed transhipment`, location: port, vessel: tsVessel });
    });
  }

  if (arrivalDate) events.push({ date: arrivalDate, description: 'Arrived at destination', location: pod || '', vessel: vessel });
  if (dischargeDate) events.push({ date: dischargeDate, description: 'Discharged', location: pod || '', vessel: '' });
  if (gateOutDate) events.push({ date: gateOutDate, description: 'Gate Out', location: pod || '' });

  // Sort events by date
  events.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // BL containers
  const blContainers = sd.BLContainers || [];
  const containers = Array.isArray(blContainers) ? blContainers.map(c => ({
    number: c.ContainerNumber || c,
    type: '', status: '',
  })) : [];

  const hasData = !!(origin || destination || eta || vessel || events.length > 0 || status);

  return {
    success: true,
    hasData,
    number,
    detectedCarrier: carrier,
    shippingLine: carrier,
    billOfLading: bl,
    containerNumber: containerNum,
    containerType: containerType + (containerTEU ? ` ${containerTEU}'` : ''),
    status,
    portOfLading: origin,
    portOfDischarge: destination,
    fromCountry,
    toCountry,
    eta,
    firstETA,
    etd: departureDate,
    vesselName: vessel,
    voyageNumber: vesselVoyage,
    vesselIMO,
    latitude: vesselLat !== 'Not Supported' ? vesselLat : null,
    longitude: vesselLng !== 'Not Supported' ? vesselLng : null,
    transitTime,
    containers,
    events,
    liveMapUrl: sd.LiveMapUrl || '',
    co2: sd.Co2Emission || '',
    message: hasData ? 'Datos obtenidos exitosamente' : 'Tracking creado, datos en procesamiento. Intenta en 5-10 min.',
    raw: sd,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, () => {
  console.log(`🚢 ShipsGo Proxy en puerto ${PORT}`);
  console.log(`   POST /api/track         — Rastrear contenedor/BL`);
  console.log(`   GET  /api/status/:num   — Consultar datos (sin gastar crédito)`);
  console.log(`   GET  /api/carriers      — Lista de navieras`);
});
