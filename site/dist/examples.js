export const examples = [
  {id:'counter', title:'State and actions', description:'A counter with shared state and two actions. Change a value and the interface updates.', source:`(app counter
  (state count 0)

  (page "/" home
    (v :gap 24 :pad 32
      (heading "Counter")
      (txt count :size 64)
      (h :gap 12
        (btn "Add one"
          (click (set count (+ count 1))))
        (btn "Reset"
          (click (set count 0)))))))`},
  {id:'functions', title:'Functions and collections', description:'Define a typed function, map it over a list, and sum the result. This application renders “Total: 14”.', source:`(app functions
  (fn square
    ((x number))
    (* x x))

  (fn total-squares (items)
    (sum (map square items)))

  (page "/" home
    (v :pad 24 :gap 12
      (heading "Pure functions")
      (txt "Total: "
        (total-squares (arr 1 2 3))))))`},
  {id:'notes', title:'Database to interface', description:'A SQLite table, two API routes, and a form. Add a note, refresh the resource, and render the saved rows.', source:`(app notes
  (db
    (table notes (id auto) (text string)))

  (api
    (get "/api/notes" (select notes))
    (post "/api/notes"
      (input (text string))
      (insert notes :text body.text)))

  (data
    (resource notes "/api/notes" :default (arr)))

  (state draft "")

  (page "/" home
    (v :pad 24 :gap 12
      (heading "Notes")
      (input :value draft :label "New note")
      (btn "Add note"
        (click
          (send post "/api/notes" :text draft)
          (refresh notes)
          (set draft "")))
      (each note notes.data (txt note.text)))))`}
];
