/*
beginnings of an ADS-B signalk plugin

inspired by Karl-Erik Gustafsson net-ais-plugin
MIT License
*/

const client = require("@signalk/client");
var net = require("net");

module.exports = function createPlugin(app) {
  const plugin = {};
  plugin.id = "net-adsb-plugin";
  plugin.name = "Net-ADSB";
  plugin.description = "ADS-B traffic information gathered from readsb";

  var uuid_postfix = "00-acff-4f92-9830-0721a7206cb4";
  var position_radius = null;
  var unsubscribes = [];
  const setStatus = app.setPluginStatus || app.setProviderStatus;
  var retry_timeout = null;
  var client = null;

  plugin.start = function (options, restartPlugin) {
    readsb_host = options.readsb_host;
    readsb_port = options.readsb_port;
    position_radius = options.position_radius;
    path_timeout = options.path_timeout;
    app.debug("readsb_host: " + readsb_host);
    app.debug("readsb_port: " + readsb_port);
    app.debug("position_radius: " + position_radius);
    app.debug("path_timeout: " + path_timeout);

    app.debug("Plugin started");
    let localSubscription = {
      context: `vessels.self`,
      subscribe: [
        {
          path: "navigation.position.value",
          period: 10000,
        },
      ],
    };

    app.subscriptionmanager.subscribe(
      localSubscription,
      unsubscribes,
      (subscriptionError) => {
        app.error("Error:" + subscriptionError);
      },
      (delta) => {
        delta.updates.forEach((u) => {
          app.debug(u);
        });
      }
    );

    client = new net.Socket();

    client.on("connect", function () {
      app.debug(`connected to readsb at ${readsb_host}:${readsb_port}`);
      if (retry_timeout) {
        clearTimeout(retry_timeout);
      }
      setStatus(`connected to readsb at ${readsb_host}:${readsb_port}`);
    });

    client.on("data", function (data) {
      // app.debug("Received: " + data);
      try {
        const obj = JSON.parse(data);
        read_info(obj);
      } catch (e) {
        app.debug("JSON error: " + e + " -- " + data);
      }
    });

    client.on("error", (e) => {
      app.debug(`client.on_error: ${e}`);

      setStatus("connection error: " + e);
      if (e.code === "ECONNREFUSED") {
        retry_timeout = setTimeout(function () {
          client.connect(readsb_port, readsb_host).on("error", (err) => {
            clearTimeout(retry_timeout);
          });
        }, 2000);
      }
    });

    client.on("close", function () {
      app.debug("client connection closed");

      setStatus(`disconnected from readsb ${readsb_host}:${readsb_port}`);
      if (!restartPlugin) {
        retry_timeout = setTimeout(function () {
          setStatus(
            `scheduled reconnect to readsb ${readsb_host}:${readsb_port}`
          );
          client.connect(readsb_port, readsb_host);
        }, 2000);
      }
    });

    client.connect(readsb_port, readsb_host).on("error", (err) => {
      app.debug("connect failed: " + err);
      setStatus("connect failed: " + err);
    });
  };

  function knots_to_mps(speed) {
    return speed * 0.514444;
  }

  function ft_to_m(distance) {
    return distance * 0.3048;
  }

  read_info = function read_data(m) {
    // app.debug(m);
    // return;
    app.debug(`${m.hex}: ${m.r}`);
    const values = [
      // {
      //   path: "",
      //   value: { name: m.hex },
      // },
      {
        path: "navigation.position",
        value: {
          altitude: ft_to_m(m.alt_baro),
          latitude: m.lat,
          longitude: m.lon,
        },
      },
      {
        path: "navigation.datetime",
        value: new Date(m.now * 1000).toISOString(),
      },
      {
        path: "navigation.speedOverGround",
        value: knots_to_mps(m.gs || m.tas),
      },
    ];
    // if (m.aircraftInfo.countryName) {
    //   values.push({
    //     path: "flag",
    //     value: m.aircraftInfo.countryName,
    //   });
    // }
    if (m.nav_modes) {
      values.push({
        path: "navigation.state",
        value: m.nav_modes.join(" "),
      });
    }

    if (m.desc) {
      values.push({
        path: "design.aisShipType",
        value: { name: m.desc },
      });
    }

    if (m.r) {
      values.push({
        path: "",
        value: {
          registrations: {
            national: m.r,
          },
          callsignVhf: m.r,
        },
      });
    }

    if (m.track) {
      values.push({
        path: "navigation.courseOverGroundTrue",
        value: m.track,
      });
    }
    if (m.mag_heading) {
      values.push({
        path: "navigation.courseOverGroundMagnetic",
        value: m.mag_heading,
      });
    }
    if (m.flight) {
      values.push({
        path: "name",
        value: m.flight.trim(),
      });
    }

    var properties = {
      path: "properties",
      value: {},
    };
    if (m.squawk) {
      properties.value.squawk = m.squawk;
    }

    const update = {
      context: "aircraft.urn:mrn:signalk:uuid:" + m.hex + uuid_postfix,
      updates: [
        {
          values: values,
          source: { label: plugin.id },
          timestamp: new Date().toISOString(),
        },
      ],
    };
    app.handleMessage("net-adsb-plugin", update);
  };

  plugin.stop = function stop() {
    try {
      if (retry_timeout) {
        clearTimeout(retry_timeout);
      }
      client.end();
      client.destroy();
    } catch (e) {}
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
    app.debug("Net-ADSB Stopped");
  };

  plugin.schema = {
    type: "object",
    properties: {
      readsb_host: {
        type: "string",
        default: "127.0.0.1",
        title: "host running readsb with --net-json-port",
      },
      readsb_port: {
        type: "integer",
        default: 30012,
        title: "port number - see readsb --net-json-port",
      },
      position_radius: {
        type: "integer",
        default: 50,
        title: "display ADS-B targets around the vessel (radius in km)",
      },
      path_timeout: {
        type: "number",
        default: 5.0,
        title: "path lifetime in S",
      },
    },
  };

  return plugin;
};

