const express = require('express');
const cors = require('cors');
const axios = require('axios');
 
const app = express();
const PORT = process.env.PORT || 3001;
 
app.use(cors());
app.use(express.json());
 
const T49_KEY = process.env.T49_API_KEY || 'aySoHGYUv1dT4ua4hfhg4icp';
const T49 = 'https://api.terminal49.com/v2';
const T49H = { 'Content-Type': 'application/vnd.api+json', 'Authorization': `Token ${T49_KEY}` };
 
const CARRIER_SCAC = { 'MSC':'MSCU','Maersk':'MAEU','CMA CGM':'CMDU','Hapag-Lloyd':'HLCU','COSCO':'COSU','Evergreen':'EGLV','ONE':'ONEY','Yang Ming':'YMLU','ZIM':'ZIMU' };
const PREFIX_SCAC = { MSCU:'MSCU',MEDU:'MSCU',MSMU:'MSCU',MAEU:'MAEU',MSKU:'MAEU',MRKU:'MAEU',CMAU:'CMDU',CGMU:'CMDU',HLBU:'HLCU',HLCU:'HLCU',HLXU:'HLCU',CCLU:'COSU',CSNU:'COSU',CSQU:'COSU',CBHU:'COSU',EISU:'EGLV',EGHU:'EGLV',EMCU:'EGLV',ONEY:'ONEY',ONEU:'ONEY',YMLU:'YMLU',YMMU:'YMLU',ZIMU:'ZIMU',ZCSU:'ZIMU' };
const SCAC_NAME = {}; Object.entries(CARRIER_SCAC).forEach(([n,s])=>{ SCAC_NAME[s]=n; });
 
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Terminal49 Proxy' }));
 
// ═══ TRACK: crear tracking request y devolver datos ═══
app.post('/api/track', async (req, res) => {
  const { number, carrier } = req.body;
  if (!number) return res.status(400).json({ success: false, error: 'Número requerido' });
 
  const num = number.trim().toUpperCase();
  let scac = carrier && CARRIER_SCAC[carrier] ? CARRIER_SCAC[carrier] : PREFIX_SCAC[num.substring(0,4)] || '';
  const isContainer = /^[A-Z]{4}\d{7,8}$/.test(num);
  const type = isContainer ? 'container' : 'bill_of_lading';
 
  // 1. Create tracking request
  try {
    await axios.post(`${T49}/tracking_requests`, {
      data: { type: 'tracking_request', attributes: { request_type: type, request_number: num, scac } }
    }, { headers: T49H, timeout: 15000 });
  } catch (e) {
    const msg = e.response?.data?.errors?.[0]?.detail || e.message;
    // If already tracked, continue to fetch data
    if (!msg.includes('already') && !msg.includes('exists')) {
      return res.json({ success: false, error: msg, number: num, detectedCarrier: SCAC_NAME[scac] || '' });
    }
  }
 
  // 2. Wait and fetch data
  await sleep(3000);
 
  // 3. Get all shipments and find matching one
  try {
    const resp = await axios.get(`${T49}/shipments?include=containers`, { headers: T49H, timeout: 20000 });
    const shipments = resp.data?.data || [];
    const included = resp.data?.included || [];
 
    // Find matching shipment
    let match = shipments.find(s => {
      const a = s.attributes || {};
      if (a.bill_of_lading_number === num) return true;
      if (a.booking_number === num) return true;
      // Check containers
      const cIds = (s.relationships?.containers?.data || []).map(c => c.id);
      return included.some(i => i.type === 'container' && cIds.includes(i.id) && i.attributes?.number === num);
    });
 
    if (!match && shipments.length > 0) match = shipments[0]; // fallback to latest
 
    if (match) {
      const a = match.attributes || {};
      const cIds = (match.relationships?.containers?.data || []).map(c => c.id);
      const containers = included.filter(i => i.type === 'container' && cIds.includes(i.id)).map(c => ({
        number: c.attributes?.number || '',
        type: c.attributes?.equipment_type || '',
        status: c.attributes?.status || '',
        weightKg: c.attributes?.weight_kg || '',
        seal: c.attributes?.seal_number || '',
        podArrived: c.attributes?.pod_arrived_at || '',
        podDischarged: c.attributes?.pod_discharged_at || '',
        polLoaded: c.attributes?.pol_loaded_at || '',
      }));
 
      // Get transport events for the first container
      let events = [];
      if (cIds.length > 0) {
        try {
          const evResp = await axios.get(`${T49}/containers/${cIds[0]}/transport_events`, { headers: T49H, timeout: 15000 });
          events = (evResp.data?.data || []).map(e => ({
            date: e.attributes?.actual_time || e.attributes?.estimated_time || '',
            description: e.attributes?.description || e.attributes?.event || '',
            location: e.attributes?.location || '',
            vessel: e.attributes?.vessel_name || '',
            voyage: e.attributes?.voyage_number || '',
          })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        } catch (evErr) { /* events unavailable */ }
      }
 
      return res.json({
        success: true,
        number: num,
        detectedCarrier: a.shipping_line_name || SCAC_NAME[a.shipping_line_scac] || SCAC_NAME[scac] || '',
        shippingLine: a.shipping_line_name || SCAC_NAME[a.shipping_line_scac] || '',
        billOfLading: a.bill_of_lading_number || '',
        status: a.status || '',
        portOfLading: a.port_of_lading_name || '',
        portOfLadingCode: a.port_of_lading_locode || '',
        portOfDischarge: a.port_of_discharge_name || '',
        portOfDischargeCode: a.port_of_discharge_locode || '',
        finalDestination: a.final_destination_name || '',
        vesselName: a.vessel_name || '',
        voyageNumber: a.voyage_number || '',
        eta: a.pod_eta || '',
        etd: a.pol_etd || '',
        actualArrival: a.pod_arrived_at || '',
        actualDeparture: a.pol_loaded_at || '',
        containers,
        events,
      });
    }
 
    return res.json({
      success: true,
      number: num,
      detectedCarrier: SCAC_NAME[scac] || '',
      message: 'Tracking creado. Los datos tardan 1-3 minutos. Intenta de nuevo.',
      status: 'processing',
    });
  } catch (e) {
    return res.json({
      success: true,
      number: num,
      detectedCarrier: SCAC_NAME[scac] || '',
      message: 'Tracking request creado. Intenta de nuevo en 1-2 minutos para obtener datos.',
      status: 'processing',
    });
  }
});
 
// ═══ GET SHIPMENTS ═══
app.get('/api/shipments', async (req, res) => {
  try {
    const resp = await axios.get(`${T49}/shipments?include=containers`, { headers: T49H, timeout: 20000 });
    const shipments = (resp.data?.data || []).map(s => {
      const a = s.attributes || {};
      const included = resp.data?.included || [];
      const cIds = (s.relationships?.containers?.data || []).map(c => c.id);
      const containers = included.filter(i => i.type === 'container' && cIds.includes(i.id)).map(c => ({
        number: c.attributes?.number || '',
        type: c.attributes?.equipment_type || '',
        status: c.attributes?.status || '',
      }));
 
      return {
        id: s.id,
        billOfLading: a.bill_of_lading_number || '',
        shippingLine: a.shipping_line_name || SCAC_NAME[a.shipping_line_scac] || '',
        status: a.status || '',
        portOfLading: a.port_of_lading_name || '',
        portOfDischarge: a.port_of_discharge_name || '',
        vesselName: a.vessel_name || '',
        eta: a.pod_eta || '',
        etd: a.pol_etd || '',
        containers,
      };
    });
    res.json({ success: true, shipments });
  } catch (e) { res.json({ success: false, error: e.message }); }
});
 
// ═══ TRACK BULK ═══
app.post('/api/track-bulk', async (req, res) => {
  const { containers } = req.body;
  if (!containers?.length) return res.status(400).json({ error: 'Array vacío' });
 
  const results = [];
  for (const c of containers) {
    const num = (c.number || '').trim().toUpperCase();
    const scac = c.carrier && CARRIER_SCAC[c.carrier] ? CARRIER_SCAC[c.carrier] : PREFIX_SCAC[num.substring(0,4)] || '';
    const isContainer = /^[A-Z]{4}\d{7,8}$/.test(num);
 
    try {
      await axios.post(`${T49}/tracking_requests`, {
        data: { type: 'tracking_request', attributes: { request_type: isContainer ? 'container' : 'bill_of_lading', request_number: num, scac } }
      }, { headers: T49H, timeout: 10000 });
      results.push({ number: num, success: true });
    } catch (e) {
      const msg = e.response?.data?.errors?.[0]?.detail || e.message;
      results.push({ number: num, success: msg.includes('already') || msg.includes('exists'), error: msg });
    }
    await sleep(400);
  }
 
  // Wait then fetch all data
  await sleep(4000);
 
  try {
    const resp = await axios.get(`${T49}/shipments?include=containers`, { headers: T49H, timeout: 20000 });
    const shipments = (resp.data?.data || []).map(s => {
      const a = s.attributes || {};
      const included = resp.data?.included || [];
      const cIds = (s.relationships?.containers?.data || []).map(c => c.id);
      const cons = included.filter(i => i.type === 'container' && cIds.includes(i.id)).map(c => ({
        number: c.attributes?.number || '',
        status: c.attributes?.status || '',
        type: c.attributes?.equipment_type || '',
      }));
      return {
        billOfLading: a.bill_of_lading_number || '',
        shippingLine: a.shipping_line_name || SCAC_NAME[a.shipping_line_scac] || '',
        status: a.status || '',
        portOfLading: a.port_of_lading_name || '',
        portOfDischarge: a.port_of_discharge_name || '',
        vesselName: a.vessel_name || '',
        eta: a.pod_eta || '',
        containers: cons,
      };
    });
    res.json({ success: true, message: `${results.filter(r=>r.success).length}/${results.length} procesados`, results, shipments });
  } catch (e) {
    res.json({ success: true, message: 'Tracking requests creados, datos disponibles en 1-2 min', results });
  }
});
 
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
 
app.listen(PORT, () => {
  console.log(`🚢 Terminal49 Proxy en puerto ${PORT}`);
});
 
