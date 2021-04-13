const {Gio, Shell, Meta, St, Clutter, Secret, GLib, Soup, GObject} = imports.gi;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

// const Utils = Me.imports.utils;
const Convenience = imports.misc.extensionUtils;
const Me = Convenience.getCurrentExtension();
// const Util = imports.misc.util;

const Lang = imports.lang;

// MainLoop for updating the time every X seconds.
const Mainloop = imports.mainloop;
const Utils = Me.imports.utils;

let hassExtension;

let soupSyncSession = new Soup.SessionSync();

var HassExtension = GObject.registerClass ({
    GTypeName: "HassMenu"
}, class HassMenu extends PanelMenu.Button {
    _init() {
        super._init(0, Me.metadata.name, false);
        this._settings = Convenience.getSettings('org.gnome.shell.extensions.hass-data');
        this._settings.connect("changed", Lang.bind(this, function() {
            if (this.needsRebuild()) {
                this.rebuildTray();
            }
        }));

        // Add tray icon
        let icon = new St.Icon({
            gicon : Gio.icon_new_for_string( Me.dir.get_path() + '/icons/hass-main.png' ),
            style_class : 'system-status-icon',
        });
        this.add_child(icon);

        this.needsRebuild();
        this.rebuildTray();
    }

    rebuildTray() {
        log("Rebuilding tray...");
        // Destroy the previous menu items
        let oldItems = this.menu._getMenuItems();
        for (let item in oldItems) {
            oldItems[item].destroy();
        }
        // Parse togglable entity ids as given from the settings
        let itemName;
        // I am using an array of objects because I want to get a full copy of the 
        // pmItem and the entityId. If I don't do that then the pmItem will be connected 
        // only to the laste entry of 'togglable_ent_ids' which means that whichever entry
        // of the menu you press, you will always toggle the same button
        var pmItems = [];
        for (let entityId in this.togglable_ent_ids) {
            if (entityId === "" || !entityId.includes("."))
                continue
            // Capitalize every word
            itemName = entityId.split(".")[1].split("_").
                                   map(word => word.charAt(0).
                                               toUpperCase() + word.slice(1)
                                   ).
                                   join(" ");
            let pmItem = new PopupMenu.PopupMenuItem('Toggle:');
            pmItem.add_child(
                new St.Label({
                    text : itemName
                })
            );
            this.menu.addMenuItem(pmItem);
            pmItems.push({item: pmItem, entity: entityId});
        }
        for (let item of pmItems) {
            item.item.connect('activate', () => {
                _toggleEntity(item.entity)
            });
        }

        // Now build the submenu containing the HASS events
        let subItem = new PopupMenu.PopupSubMenuMenuItem('HASS Events');
        this.menu.addMenuItem(subItem);
        let start_hass_item = new PopupMenu.PopupMenuItem('Start Home Assistant');
        let stop_hass_item = new PopupMenu.PopupMenuItem('Stop Home Assistant');
        let close_hass_item = new PopupMenu.PopupMenuItem('Close Home Assistant');
        subItem.menu.addMenuItem(start_hass_item, 0);
        subItem.menu.addMenuItem(stop_hass_item, 1);
        subItem.menu.addMenuItem(close_hass_item, 2);
        start_hass_item.connect('activate', () => {
            _triggerHassEvent('start');
        });
        stop_hass_item.connect('activate', () => {
            _triggerHassEvent('stop');
        });
        close_hass_item.connect('activate', () => {
            _triggerHassEvent('close');
        });

        // Settings button (Preferences)
        let popupImageMenuItem = new PopupMenu.PopupImageMenuItem(
            "Preferences",
            'security-high-symbolic',
        );
        popupImageMenuItem.connect('activate', () => {
            log("Opening Preferences...");
            Convenience.openPrefs();
        });
        this.menu.addMenuItem(popupImageMenuItem);
    }

    _toggleEntity(entityId) {
        let data = `{"entity_id": "${entityId}"}`;
        let result = Utils.send_request(`${this.base_url}api/services/switch/toggle`, 'POST', data);
        if (!result) {
            return false;
        }
        return true;
    }

    _triggerHassEvent(event) {
        let result = Utils.send_request(`${this.base_url}api/events/homeassistant_${event}`, 'POST');
        if (!result) {
            return false;
        }
        return true;
    }

    _buildTempSensorStats() {
        if (this.showWeatherStats === true) {
            // Add the temperature in the panel
            this.weatherStatsPanel = new St.Bin({
                style_class : "panel-button",
                reactive : true,
                can_focus : true,
                track_hover : true,
                height : 30,
            });
            this.weatherStatsPanelText = new St.Label({
                text : "-°C",
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._refreshWeatherStats();
            this.weatherStatsPanel.set_child(this.weatherStatsPanelText);
            this.weatherStatsPanel.connect("button-press-event", _refreshWeatherStats);

            if (doRefresh === true) {
                // Update weather stats every X seconds
                this.refreshTimeout = Mainloop.timeout_add_seconds(this.refreshSeconds,  this._refreshWeatherStats);
            }

            Main.panel._rightBox.insert_child_at_index(this.weatherStatsPanel, 1);
        }
    }

    _refreshWeatherStats() {
        try {
            if (this.showWeatherStats === true) {
                let out = "";
                // if showWeatherStats is true then the temperature must be shown (the humidity can be turned off)
                out += this.getWeatherSensorData(tempEntityID);
                if (this.showHumidity === true) {
                    out += ` | ${this.getWeatherSensorData(humidityEntityID)}`;
                }
                this.weatherStatsPanelText.text = out;
            }
        } catch (error) {
            logError(error, "Could not refresh weather stats...");
            // will execute this function only once and abort. 
            // Remove in order to make the Main loop continue working.
            return false;
        }
        // By returning true, the function will continue refresing every X seconds
        return true; 
    }

    getWeatherSensorData(entity_id) {
        let json_result = Utils.send_request(`${this.base_url}api/states/${entity_id}`);
        if (!json_result) {
            return false;
        }
        return `${json_result.state} ${json_result.attributes.unit_of_measurement}`;
    }

    needsRebuild() {
        let trayNeedsRebuild = false;
        let tmp;

        // Check if the hass url changed.
        tmp = this.base_url;
        this.base_url = this._settings.get_string('hass-url');
        if (!this.base_url.endsWith("/")) {
            this.base_url += "/";  //  needs a trailing slash
        }
        if (tmp !== this.base_url) {
            trayNeedsRebuild = true;
        }

        // Check togglable ids
        tmp = this.togglable_ent_ids;
        this.togglable_ent_ids = this._settings.get_strv("hass-togglable-entities");
        if (tmp !== this.togglable_ent_ids) {
            trayNeedsRebuild = true;
        }

        // Check show weather stats
        tmp = this.showWeatherStats;
        this.showWeatherStats = this._settings.get_boolean('show-weather-stats');
        if (tmp !== this.showWeatherStats) {
            trayNeedsRebuild = true;
        }

        // Check show humidity
        tmp = this.showHumidity;
        this.showHumidity = this._settings.get_boolean('show-humidity');
        if (tmp !== this.showHumidity) {
            trayNeedsRebuild = true;
        }

        // Check temperature id change
        tmp = this.tempEntityID;
        this.tempEntityID = this._settings.get_string("temp-entity-id");
        if (tmp !== this.tempEntityID) {
            trayNeedsRebuild = true;
        }

        // Check humidity id change
        tmp = this.humidityEntityID;
        this.humidityEntityID = this._settings.get_string("humidity-entity-id");
        if (tmp !== this.humidityEntityID) {
            trayNeedsRebuild = true;
        }

        // Check refresh seconds changed
        tmp = this.refreshSeconds;
        this.refreshSeconds = Number(this._settings.get_string('weather-refresh-seconds'));
        if (tmp !== this.refreshSeconds) {
            trayNeedsRebuild = true;
        }

        // Check doRefresh
        tmp = this.doRefresh;
        this.doRefresh = this._settings.get_boolean("refresh-weather");
        if (tmp !== this.doRefresh) {
            trayNeedsRebuild = true;
        }
        
        return trayNeedsRebuild;
    }
})


function init() {

}


function enable() {
    hassExtension = new HassExtension();
    Main.panel.addToStatusArea('hass-extension', hassExtension, 1);
    // For the Shortcut
    // Shell.ActionMode.NORMAL
    // Shell.ActionMode.OVERVIEW
    // Shell.ActionMode.LOCK_SCREEN
    let mode = Shell.ActionMode.ALL;

    // Meta.KeyBindingFlags.PER_WINDOW
    // Meta.KeyBindingFlags.BUILTIN
    // Meta.KeyBindingFlags.IGNORE_AUTOREPEAT
    let flag = Meta.KeyBindingFlags.NONE;

    let shortcut_settings = Convenience.getSettings('org.gnome.shell.extensions.hass-shortcut');

    Main.wm.addKeybinding("hass-shortcut", shortcut_settings, flag, mode, () => {
        hassExtension.menu.toggle();
    });
}


function disable () {
    hassExtension.destroy();

    // Disable shortcut
    Main.wm.removeKeybinding("hass-shortcut");

    if (showWeatherStats === true) {
        Main.panel._rightBox.remove_child(weatherStatsPanel);
        if (doRefresh === true) {
            Mainloop.source_remove(refreshTimeout);
        }
    }
}