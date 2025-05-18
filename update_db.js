const mysql = require('mysql2');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Create a connection to the database
const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'job_assignment'
});

// Connect to the database
db.connect((err) => {
  if (err) {
    console.error('Error connecting to the database:', err);
    process.exit(1);
  }
  console.log('Connected to the database');

  // Run the ALTER TABLE query to add the is_group column
  db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_group BOOLEAN DEFAULT FALSE', (err, result) => {
    if (err) {
      console.error('Error adding is_group column:', err);
    } else {
      console.log('Successfully added is_group column to messages table');
    }

    // Create the chat_groups table if it doesn't exist
    const createGroupsTable = `
      CREATE TABLE IF NOT EXISTS chat_groups (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        creator_id INT NOT NULL,
        group_id VARCHAR(50) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `;
    
    db.query(createGroupsTable, (err, result) => {
      if (err) {
        console.error('Error creating chat_groups table:', err);
      } else {
        console.log('chat_groups table created or already exists');
      }

      // Create the group_members table if it doesn't exist
      const createGroupMembersTable = `
        CREATE TABLE IF NOT EXISTS group_members (
          id INT AUTO_INCREMENT PRIMARY KEY,
          group_id VARCHAR(50) NOT NULL,
          user_id INT NOT NULL,
          joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE KEY (group_id, user_id)
        )
      `;
      
      db.query(createGroupMembersTable, (err, result) => {
        if (err) {
          console.error('Error creating group_members table:', err);
        } else {
          console.log('group_members table created or already exists');
        }

        // Close the connection
        db.end((err) => {
          if (err) {
            console.error('Error closing connection:', err);
          }
          console.log('Database schema update completed');
          process.exit(0);
        });
      });
    });
  });
}); 