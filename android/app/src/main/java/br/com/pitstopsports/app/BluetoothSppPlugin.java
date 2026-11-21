package br.com.pitstopsports.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothServerSocket;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

@CapacitorPlugin(
    name = "BluetoothSpp",
    permissions = {
        @Permission(
            alias = "bluetooth",
            strings = {
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.BLUETOOTH_SCAN
            }
        )
    }
)
public class BluetoothSppPlugin extends Plugin {
    private static final String SERVICE_NAME = "PitStopDroidPiloto";
    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    private BluetoothAdapter adapter;
    private volatile boolean serverRunning = false;
    private BluetoothServerSocket serverSocket;
    private final CopyOnWriteArrayList<BluetoothSocket> clientSockets = new CopyOnWriteArrayList<>();
    private final CopyOnWriteArrayList<BluetoothSocket> serverAcceptedSockets = new CopyOnWriteArrayList<>();

    private BluetoothAdapter resolveAdapter() {
        if (adapter != null) return adapter;
        BluetoothManager mgr = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        if (mgr != null) {
            adapter = mgr.getAdapter();
        }
        if (adapter == null) {
            adapter = BluetoothAdapter.getDefaultAdapter();
        }
        return adapter;
    }

    private boolean hasBluetoothConnectPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return true;
        }
        return ContextCompat.checkSelfPermission(
            getContext(),
            Manifest.permission.BLUETOOTH_CONNECT
        ) == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void ensurePermissions(PluginCall call) {
        if (hasBluetoothConnectPermission()) {
            JSObject res = new JSObject();
            res.put("granted", true);
            call.resolve(res);
            return;
        }
        requestPermissionForAlias("bluetooth", call, "bluetoothPermsCallback");
    }

    @PermissionCallback
    private void bluetoothPermsCallback(PluginCall call) {
        boolean granted = getPermissionState("bluetooth") == PermissionState.GRANTED || hasBluetoothConnectPermission();
        JSObject res = new JSObject();
        res.put("granted", granted);
        call.resolve(res);
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void listBondedDevices(PluginCall call) {
        BluetoothAdapter bt = resolveAdapter();
        if (bt == null) {
            call.reject("Bluetooth não disponível neste aparelho.");
            return;
        }
        if (!hasBluetoothConnectPermission()) {
            requestPermissionForAlias("bluetooth", call, "listBondedPermsCallback");
            return;
        }
        if (!bt.isEnabled()) {
            call.reject("Ligue o Bluetooth nas configurações do celular.");
            return;
        }

        JSArray list = new JSArray();
        Set<BluetoothDevice> bonded = bt.getBondedDevices();
        if (bonded != null) {
            for (BluetoothDevice dev : bonded) {
                JSObject item = new JSObject();
                item.put("name", dev.getName() != null ? dev.getName() : dev.getAddress());
                item.put("address", dev.getAddress());
                list.put(item);
            }
        }
        JSObject ret = new JSObject();
        ret.put("devices", list);
        call.resolve(ret);
    }

    @PermissionCallback
    private void listBondedPermsCallback(PluginCall call) {
        if (hasBluetoothConnectPermission()) {
            listBondedDevices(call);
        } else {
            call.reject("Permissão de Dispositivos Próximos (Bluetooth) negada.");
        }
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void startPilotServer(PluginCall call) {
        BluetoothAdapter bt = resolveAdapter();
        if (bt == null) {
            call.reject("Bluetooth não disponível.");
            return;
        }
        if (!hasBluetoothConnectPermission()) {
            call.reject("Conceda permissão de Dispositivos Próximos primeiro.");
            return;
        }
        if (!bt.isEnabled()) {
            call.reject("Ative o Bluetooth antes de iniciar o modo escuta.");
            return;
        }

        stopAllSocketsInternal();
        serverRunning = true;

        new Thread(() -> {
            try {
                serverSocket = bt.listenUsingRfcommWithServiceRecord(SERVICE_NAME, SPP_UUID);
                emitPresence("pilot", "listening", 0, 1);
            } catch (IOException e) {
                serverRunning = false;
                emitError("Falha ao abrir canal Bluetooth SPP: " + e.getMessage());
                return;
            }

            while (serverRunning && serverSocket != null) {
                try {
                    BluetoothSocket accepted = serverSocket.accept();
                    if (accepted != null) {
                        serverAcceptedSockets.add(accepted);
                        String remoteName = accepted.getRemoteDevice() != null && accepted.getRemoteDevice().getName() != null
                            ? accepted.getRemoteDevice().getName()
                            : "Navegador";
                        emitPresence("pilot", "connected", serverAcceptedSockets.size(), 1, remoteName);
                        spawnReaderThread(accepted);
                    }
                } catch (IOException e) {
                    if (serverRunning) {
                        emitError("Conexão Bluetooth interrompida.");
                    }
                    break;
                }
            }
        }, "PitStopBtPilotServer").start();

        JSObject ok = new JSObject();
        ok.put("started", true);
        call.resolve(ok);
    }

    @SuppressLint("MissingPermission")
    private void spawnReaderThread(BluetoothSocket socket) {
        new Thread(() -> {
            try {
                BufferedReader reader = new BufferedReader(
                    new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8)
                );
                String line;
                while (serverRunning && (line = reader.readLine()) != null) {
                    if (!line.trim().isEmpty()) {
                        JSObject ev = new JSObject();
                        ev.put("json", line);
                        notifyListeners("telemetryData", ev);
                    }
                }
            } catch (IOException ignored) {
                // Socket closed
            } finally {
                serverAcceptedSockets.remove(socket);
                try {
                    socket.close();
                } catch (IOException ignored) {}
                if (serverRunning) {
                    emitPresence(
                        "pilot",
                        serverAcceptedSockets.isEmpty() ? "listening" : "connected",
                        serverAcceptedSockets.size(),
                        1
                    );
                }
            }
        }, "PitStopBtPilotReader").start();
    }

    @SuppressLint("MissingPermission")
    private void spawnClientMonitorThread(BluetoothSocket socket) {
        new Thread(() -> {
            try {
                byte[] buf = new byte[128];
                while (socket.isConnected()) {
                    int read = socket.getInputStream().read(buf);
                    if (read == -1) {
                        break;
                    }
                }
            } catch (IOException ignored) {
                // Socket closed by remote peer or local teardown
            } finally {
                boolean removed = clientSockets.remove(socket);
                try {
                    socket.close();
                } catch (IOException ignored) {}
                if (removed) {
                    emitPresence(
                        "navigator",
                        clientSockets.isEmpty() ? "disconnected" : "connected",
                        1,
                        clientSockets.size()
                    );
                }
            }
        }, "PitStopBtNavMonitor").start();
    }

    private void stopPilotServerOnly() {
        serverRunning = false;
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {}
            serverSocket = null;
        }
        for (BluetoothSocket s : serverAcceptedSockets) {
            try {
                s.close();
            } catch (IOException ignored) {}
        }
        serverAcceptedSockets.clear();
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void connectNavigator(PluginCall call) {
        BluetoothAdapter bt = resolveAdapter();
        if (bt == null || !hasBluetoothConnectPermission() || !bt.isEnabled()) {
            call.reject("Verifique se o Bluetooth está ligado e com permissão concedida.");
            return;
        }

        JSArray addressesArr = call.getArray("addresses");
        List<String> addresses = new ArrayList<>();
        Set<String> targetAddresses = new HashSet<>();
        if (addressesArr != null) {
            for (int i = 0; i < addressesArr.length(); i++) {
                try {
                    String addr = addressesArr.getString(i);
                    if (addr != null && !addr.trim().isEmpty()) {
                        String trimmed = addr.trim();
                        String upper = trimmed.toUpperCase(Locale.ROOT);
                        if (targetAddresses.add(upper)) {
                            addresses.add(trimmed);
                        }
                    }
                } catch (Exception ignored) {}
            }
        }
        String singleAddress = call.getString("address");
        if (singleAddress != null && !singleAddress.trim().isEmpty()) {
            String trimmed = singleAddress.trim();
            String upper = trimmed.toUpperCase(Locale.ROOT);
            if (targetAddresses.add(upper)) {
                addresses.add(trimmed);
            }
        }

        if (addresses.isEmpty()) {
            call.reject("Selecione ao menos um celular Piloto pareado.");
            return;
        }

        stopPilotServerOnly();

        Set<String> alreadyConnected = new HashSet<>();
        for (BluetoothSocket existing : clientSockets) {
            String remoteAddr = existing.getRemoteDevice() != null && existing.getRemoteDevice().getAddress() != null
                ? existing.getRemoteDevice().getAddress().toUpperCase(Locale.ROOT)
                : null;
            if (existing.isConnected() && remoteAddr != null && targetAddresses.contains(remoteAddr)) {
                alreadyConnected.add(remoteAddr);
            } else {
                clientSockets.remove(existing);
                try {
                    existing.close();
                } catch (IOException ignored) {}
            }
        }

        if (alreadyConnected.size() == addresses.size()) {
            emitPresence("navigator", "connected", 1, clientSockets.size());
            JSObject ok = new JSObject();
            ok.put("connecting", false);
            ok.put("connected", true);
            call.resolve(ok);
            return;
        }

        emitPresence("navigator", "connecting", 1, clientSockets.size());

        new Thread(() -> {
            try {
                if (bt.isDiscovering()) {
                    bt.cancelDiscovery();
                }
            } catch (Exception ignored) {}

            for (String addr : addresses) {
                String upper = addr.toUpperCase(Locale.ROOT);
                if (alreadyConnected.contains(upper)) {
                    continue;
                }
                try {
                    BluetoothDevice device = bt.getRemoteDevice(addr);
                    BluetoothSocket sock = device.createRfcommSocketToServiceRecord(SPP_UUID);
                    sock.connect();
                    clientSockets.add(sock);
                    spawnClientMonitorThread(sock);
                } catch (Exception ex) {
                    // Fallback insecure RFCOMM on some OEMs
                    try {
                        BluetoothDevice device = bt.getRemoteDevice(addr);
                        BluetoothSocket sock2 = device.createInsecureRfcommSocketToServiceRecord(SPP_UUID);
                        sock2.connect();
                        clientSockets.add(sock2);
                        spawnClientMonitorThread(sock2);
                    } catch (Exception ignored) {}
                }
            }

            if (!clientSockets.isEmpty()) {
                emitPresence("navigator", "connected", 1, clientSockets.size());
            } else {
                emitPresence("navigator", "disconnected", 0, 0);
                emitError("Não foi possível conectar ao Droid Piloto. Abra o modo Piloto no outro celular antes de conectar.");
            }
        }, "PitStopBtNavConnect").start();

        JSObject ok = new JSObject();
        ok.put("connecting", true);
        call.resolve(ok);
    }

    @PluginMethod
    public void sendTelemetry(PluginCall call) {
        String json = call.getString("json");
        if (json == null || json.isEmpty()) {
            call.resolve();
            return;
        }
        byte[] payload = (json + "\n").getBytes(StandardCharsets.UTF_8);
        boolean anyRemoved = false;
        for (BluetoothSocket sock : clientSockets) {
            try {
                if (sock.isConnected()) {
                    OutputStream os = sock.getOutputStream();
                    os.write(payload);
                    os.flush();
                } else {
                    if (clientSockets.remove(sock)) {
                        anyRemoved = true;
                    }
                    try {
                        sock.close();
                    } catch (IOException ignored) {}
                }
            } catch (IOException e) {
                if (clientSockets.remove(sock)) {
                    anyRemoved = true;
                }
                try {
                    sock.close();
                } catch (IOException ignored) {}
            }
        }
        if (anyRemoved) {
            emitPresence("navigator", clientSockets.isEmpty() ? "disconnected" : "connected", 1, clientSockets.size());
        }
        call.resolve();
    }

    @PluginMethod
    public void stopAll(PluginCall call) {
        stopAllSocketsInternal();
        emitPresence("none", "disconnected", 0, 0);
        call.resolve();
    }

    private void stopAllSocketsInternal() {
        serverRunning = false;
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {}
            serverSocket = null;
        }
        for (BluetoothSocket s : serverAcceptedSockets) {
            try {
                s.close();
            } catch (IOException ignored) {}
        }
        serverAcceptedSockets.clear();
        for (BluetoothSocket s : clientSockets) {
            try {
                s.close();
            } catch (IOException ignored) {}
        }
        clientSockets.clear();
    }

    private void emitPresence(String role, String status, int navigators, int pilots) {
        emitPresence(role, status, navigators, pilots, null);
    }

    private void emitPresence(String role, String status, int navigators, int pilots, String peerName) {
        JSObject ev = new JSObject();
        ev.put("role", role);
        ev.put("status", status);
        ev.put("navigators", navigators);
        ev.put("pilots", pilots);
        if (peerName != null) {
            ev.put("peerName", peerName);
        }
        notifyListeners("connectionState", ev);
    }

    private void emitError(String message) {
        JSObject ev = new JSObject();
        ev.put("message", message);
        notifyListeners("btError", ev);
    }

    @Override
    protected void handleOnDestroy() {
        stopAllSocketsInternal();
        super.handleOnDestroy();
    }
}
