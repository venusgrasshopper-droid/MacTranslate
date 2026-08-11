# Signal Desktop Runtime Notice

MacTranslate includes an embedded Signal Desktop 8.17.0 runtime for the Signal multi-account service. The runtime is loaded in embedded mode and each account is hosted in its own Electron `WebContentsView` and persistent session partition.

Signal Desktop is copyright Signal Messenger, LLC and contributors and is licensed under the GNU Affero General Public License version 3 only (`AGPL-3.0-only`). MacTranslate is not affiliated with or endorsed by Signal Messenger, LLC.

Upstream source and license:

- https://github.com/signalapp/Signal-Desktop/tree/v8.17.0
- https://github.com/signalapp/Signal-Desktop/blob/v8.17.0/LICENSE

The Signal runtime remains governed by its own license. MacTranslate-specific host and lifecycle code is included in the MacTranslate source package.
