import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { mqttService } from './server/mqttService';
import { pltsService } from './server/pltsService';
import { authenticateUser, registerUser, verifyAuthToken, changeUserPassword, getAllUsers } from './server/authService';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // CORS headers
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // Auth Middleware helper
  const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token autentikasi tidak ditemukan. Harap login.' });
    }
    const token = authHeader.split(' ')[1];
    const user = verifyAuthToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Sesi kedaluwarsa atau token tidak valid.' });
    }
    (req as any).user = user;
    next();
  };

  // --- API ROUTES ---

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      time: new Date().toISOString(),
      mqttConnected: mqttService.isConnected,
      pltsConnected: pltsService.isConnected,
    });
  });

  // Auth Endpoints
  app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email dan password wajib diisi' });
    }
    const authResult = authenticateUser(email, password);
    if (!authResult) {
      return res.status(401).json({ error: 'Email atau password salah' });
    }
    res.json({ success: true, ...authResult });
  });

  app.post('/api/auth/register', (req, res) => {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nama, email, dan password wajib diisi' });
    }
    try {
      const authResult = registerUser(name, email, password, role || 'operator');
      res.json({ success: true, ...authResult });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ success: true, user: (req as any).user });
  });

  app.post('/api/auth/change-password', requireAuth, (req, res) => {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: 'Password lama dan baru wajib diisi' });
    }
    try {
      changeUserPassword((req as any).user.id, oldPassword, newPassword);
      res.json({ success: true, message: 'Password berhasil diperbarui' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/auth/users', requireAuth, (req, res) => {
    res.json({ success: true, users: getAllUsers() });
  });

  // Aquaculture Telemetry Endpoints
  app.get('/api/telemetry/latest', (req, res) => {
    res.json({
      success: true,
      telemetry: mqttService.latestTelemetry,
      mqttStatus: mqttService.getStatus(),
    });
  });

  app.get('/api/telemetry/history', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 100;
    const history = mqttService.telemetryHistory.slice(-limit);
    res.json({
      success: true,
      count: history.length,
      history,
    });
  });

  app.get('/api/telemetry/mqtt-status', (req, res) => {
    res.json({
      success: true,
      status: mqttService.getStatus(),
    });
  });

  app.post('/api/telemetry/simulate', (req, res) => {
    const { enable } = req.body;
    const active = mqttService.toggleSimulation(enable);
    res.json({ success: true, simulationActive: active });
  });

  app.post('/api/telemetry/reconnect', (req, res) => {
    const { broker, topic } = req.body;
    mqttService.connect(broker, topic);
    res.json({ success: true, message: 'Reconnecting to MQTT broker...' });
  });

  app.post('/api/mqtt/publish', requireAuth, async (req, res) => {
    const { command, params, deviceId, token, requestId, targetTopic } = req.body;
    if (!command) {
      return res.status(400).json({ error: 'Command parameter wajib diisi' });
    }
    try {
      const result = await mqttService.publishCommand(
        command,
        params || {},
        { deviceId, token, requestId, targetTopic }
      );
      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/mqtt/acks', (req, res) => {
    res.json({
      success: true,
      latestAck: mqttService.latestAck,
      history: mqttService.ackHistory,
      deviceStatus: mqttService.deviceStatus,
    });
  });

  app.get('/api/mqtt/device-info', (req, res) => {
    res.json({
      success: true,
      deviceInfo: mqttService.latestDeviceInfo,
      config: mqttService.latestConfig,
      deviceStatus: mqttService.deviceStatus,
    });
  });

  // Server-Sent Events (SSE) stream for real-time live telemetry & PLTS
  app.get('/api/telemetry/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send initial snapshot
    res.write(`data: ${JSON.stringify({
      type: 'initial',
      telemetry: mqttService.latestTelemetry,
      mqttStatus: mqttService.getStatus(),
      plts: pltsService.lastSummary,
      latestAck: mqttService.latestAck,
      deviceInfo: mqttService.latestDeviceInfo,
      config: mqttService.latestConfig,
      deviceStatus: mqttService.deviceStatus,
    })}\n\n`);

    const onTelemetry = (data: any) => {
      res.write(`data: ${JSON.stringify({
        type: 'telemetry',
        telemetry: data,
        mqttStatus: mqttService.getStatus(),
      })}\n\n`);
    };

    const onAck = (ack: any) => {
      res.write(`data: ${JSON.stringify({
        type: 'ack',
        ack,
      })}\n\n`);
    };

    const onDeviceInfo = (info: any) => {
      res.write(`data: ${JSON.stringify({
        type: 'device_info',
        deviceInfo: info,
      })}\n\n`);
    };

    const onConfig = (cfg: any) => {
      res.write(`data: ${JSON.stringify({
        type: 'config',
        config: cfg,
      })}\n\n`);
    };

    const onDeviceStatus = (st: any) => {
      res.write(`data: ${JSON.stringify({
        type: 'device_status',
        deviceStatus: st.status,
      })}\n\n`);
    };

    const onPlts = (data: any) => {
      res.write(`data: ${JSON.stringify({
        type: 'plts',
        plts: data,
      })}\n\n`);
    };

    const onStatus = (status: any) => {
      res.write(`data: ${JSON.stringify({
        type: 'status',
        mqttStatus: mqttService.getStatus(),
      })}\n\n`);
    };

    mqttService.on('telemetry', onTelemetry);
    mqttService.on('ack', onAck);
    mqttService.on('device_info', onDeviceInfo);
    mqttService.on('config', onConfig);
    mqttService.on('device_status', onDeviceStatus);
    mqttService.on('status', onStatus);
    pltsService.on('update', onPlts);

    // Heartbeat every 15s to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      mqttService.off('telemetry', onTelemetry);
      mqttService.off('ack', onAck);
      mqttService.off('device_info', onDeviceInfo);
      mqttService.off('config', onConfig);
      mqttService.off('device_status', onDeviceStatus);
      mqttService.off('status', onStatus);
      pltsService.off('update', onPlts);
      res.end();
    });
  });

  // PLTS Solar Endpoints
  app.get('/api/plts/summary', (req, res) => {
    res.json({
      success: true,
      summary: pltsService.lastSummary,
      isConnected: pltsService.isConnected,
      lastFetchTime: pltsService.lastFetchTime,
      lastError: pltsService.lastError,
    });
  });

  app.get('/api/plts/flow', (req, res) => {
    res.json({
      success: true,
      data: pltsService.lastEnergyFlow,
      summary: pltsService.lastSummary,
      lastUpdated: pltsService.lastSummary?.lastUpdated,
      isConnected: pltsService.isConnected,
      lastFetchTime: pltsService.lastFetchTime,
    });
  });

  app.get('/api/plts/history', (req, res) => {
    res.json({
      success: true,
      history: pltsService.history,
    });
  });

  app.post('/api/plts/refresh', async (req, res) => {
    const summary = await pltsService.fetchLivePltsData();
    res.json({ success: true, summary });
  });

  app.post('/api/plts/config', requireAuth, async (req, res) => {
    const { deviceUrl, flowUrl } = req.body;
    const summary = await pltsService.setEndpoints(deviceUrl, flowUrl);
    res.json({ success: true, summary, config: pltsService.getEndpoints() });
  });

  // --- VITE & STATIC FILES ---
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[NilaSense Server] Running on http://0.0.0.0:${PORT}`);
    console.log(`[NilaSense Server] MQTT Target: broker.emqx.io:1883 | Topic: aquaculture/nila/data/nila-E0F908/telemetry`);
  });
}

startServer();
