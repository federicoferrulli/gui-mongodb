export const state = {
  connected: false,
  connLabel: '',
  dbType: 'mongodb',     // 'mongodb' | 'mysql'
  db: null,
  coll: null,
  skip: 0,
  limit: 50,
  total: 0,
  docs: [],
  columns: [],
  liveTimer: null,
  pollingInterval: null,
  view: 'data',
  expandedDbs: new Set(), // db espansi nella sidebar
  editingDoc: null,       // documento aperto nella modale di modifica riga
  dbSchema: null,         // cache dello schema per la vista UML
  dbSchemaFor: null,      // db a cui si riferisce la cache
};
