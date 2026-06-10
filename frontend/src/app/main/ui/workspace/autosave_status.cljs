;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.workspace.autosave-status
  "Word/Google-Docs style autosave status indicator for the workspace top bar.
   Reads persistence status via subscription; tracks the last :saved
   transition locally so we can render relative + absolute timestamps."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.util.i18n :refer [tr]]
   [app.util.timers :as tm]
   [rumext.v2 :as mf]))

(defn- format-hhmm
  "HH:MM in user's locale (24h or 12h depending on locale)."
  [ts]
  (try
    (-> (js/Intl.DateTimeFormat. js/undefined
                                 #js {:hour "numeric" :minute "2-digit"})
        (.format (js/Date. ts)))
    (catch :default _
      (let [d (js/Date. ts)
            h (.getHours d)
            m (.getMinutes d)]
        (str h ":" (when (< m 10) "0") m)))))

(mf/defc autosave-status*
  "Subscribes to refs/persistence, renders a small status line.
   States: nil/initial -> empty, :pending -> 'Unsaved changes',
   :saving -> 'Saving…', :saved -> 'Saved · HH:MM' (or 'a few seconds ago'),
   :error -> 'Save failed · retry'."
  []
  (let [persistence (mf/deref refs/persistence)
        status      (:status persistence)

        ;; Track last :saved transition in local state so the indicator
        ;; can render relative time without mutating the global store.
        last-saved* (mf/use-state nil)
        last-saved  (deref last-saved*)

        ;; Tick every second to refresh the relative-time label.
        now*        (mf/use-state #(js/Date.now))
        now         (deref now*)]

    ;; When we observe a :saved status, stamp the local last-saved time.
    (mf/with-effect [status]
      (when (= status :saved)
        (reset! last-saved* (js/Date.now))))

    ;; Drive a 1s ticker so the relative time label refreshes while idle.
    (mf/with-effect []
      (let [iv (tm/interval 1000 #(reset! now* (js/Date.now)))]
        #(tm/dispose! iv)))

    (let [retry
          (mf/use-fn
           (fn [e]
             (.preventDefault ^js e)
             (st/emit! :app.main.data.persistence/force-persist)))

          age-sec (when last-saved (/ (- now last-saved) 1000))

          label
          (cond
            (= status :saving)  (tr "workspace.autosave.saving")
            (= status :pending) (tr "workspace.autosave.unsaved")
            (= status :error)   (tr "workspace.autosave.error")
            (and (= status :saved) last-saved (< age-sec 30))
            (tr "workspace.autosave.saved-just-now")
            (and (= status :saved) last-saved (< age-sec 60))
            (tr "workspace.autosave.saved-a-minute-ago")
            (and (= status :saved) last-saved)
            (tr "workspace.autosave.saved-at" (format-hhmm last-saved))
            :else nil)

          tooltip
          (cond
            (= status :error) (tr "workspace.autosave.error.tooltip")
            last-saved        (str (tr "workspace.autosave.tooltip.autosave-on")
                                   " · "
                                   (format-hhmm last-saved))
            :else             (tr "workspace.autosave.tooltip.autosave-on"))]

      (when label
        [:div {:class (stl/css :autosave-status)
               :role "status"
               :aria-live "polite"
               :title tooltip}
         [:span {:class (case status
                          :saving  (stl/css :autosave-dot :dot-saving)
                          :pending (stl/css :autosave-dot :dot-pending)
                          :error   (stl/css :autosave-dot :dot-error)
                          (stl/css :autosave-dot :dot-saved))
                 :aria-hidden true}]
         [:span {:class (stl/css :autosave-label)} label]
         (when (= status :error)
           [:a {:class (stl/css :autosave-retry)
                :href "#"
                :on-click retry}
            (tr "workspace.autosave.retry")])]))))
