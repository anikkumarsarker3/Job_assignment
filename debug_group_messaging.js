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

  // Check if messages table has is_group column
  checkMessageTable();
});

function checkMessageTable() {
  db.query('SHOW COLUMNS FROM messages', (err, results) => {
    if (err) {
      console.error('Error checking messages table schema:', err);
      closeConnection();
      return;
    }

    console.log('\n--- Messages Table Columns ---');
    const hasIsGroup = results.some(column => column.Field === 'is_group');
    
    results.forEach(column => {
      console.log(`${column.Field} (${column.Type}, ${column.Null === 'YES' ? 'Nullable' : 'Not Nullable'})`);
    });
    
    console.log(`\nIs 'is_group' column present: ${hasIsGroup ? 'YES' : 'NO'}`);
    
    if (!hasIsGroup) {
      console.log('Adding is_group column to messages table...');
      db.query('ALTER TABLE messages ADD COLUMN is_group BOOLEAN DEFAULT FALSE', (err) => {
        if (err) {
          console.error('Error adding is_group column:', err);
        } else {
          console.log('Added is_group column successfully');
        }
        
        checkGroupTables();
      });
    } else {
      checkGroupTables();
    }
  });
}

function checkGroupTables() {
  // Check chat_groups table
  db.query('SHOW TABLES LIKE "chat_groups"', (err, results) => {
    if (err) {
      console.error('Error checking for chat_groups table:', err);
      closeConnection();
      return;
    }
    
    const hasChatGroupsTable = results.length > 0;
    console.log(`\n--- Chat Groups Table Present: ${hasChatGroupsTable ? 'YES' : 'NO'} ---`);
    
    // Check group_members table
    db.query('SHOW TABLES LIKE "group_members"', (err, results) => {
      if (err) {
        console.error('Error checking for group_members table:', err);
        closeConnection();
        return;
      }
      
      const hasGroupMembersTable = results.length > 0;
      console.log(`--- Group Members Table Present: ${hasGroupMembersTable ? 'YES' : 'NO'} ---`);
      
      if (hasChatGroupsTable) {
        checkExistingGroups();
      } else {
        console.log('Creating chat_groups and group_members tables...');
        createGroupTables();
      }
    });
  });
}

function createGroupTables() {
  // Create chat_groups table
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
  
  db.query(createGroupsTable, (err) => {
    if (err) {
      console.error('Error creating chat_groups table:', err);
      closeConnection();
      return;
    }
    
    console.log('Created chat_groups table');
    
    // Create group_members table
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
    
    db.query(createGroupMembersTable, (err) => {
      if (err) {
        console.error('Error creating group_members table:', err);
      } else {
        console.log('Created group_members table');
      }
      
      checkExistingGroups();
    });
  });
}

function checkExistingGroups() {
  // Check for existing groups
  db.query('SELECT * FROM chat_groups', (err, groups) => {
    if (err) {
      console.error('Error fetching groups:', err);
      closeConnection();
      return;
    }
    
    console.log(`\n--- Found ${groups.length} groups ---`);
    
    if (groups.length > 0) {
      groups.forEach(group => {
        console.log(`Group: ${group.name} (ID: ${group.group_id})`);
        
        // Check members for this group
        db.query(
          'SELECT gm.*, u.name FROM group_members gm JOIN users u ON gm.user_id = u.id WHERE gm.group_id = ?',
          [group.group_id],
          (err, members) => {
            if (err) {
              console.error(`Error fetching members for group ${group.group_id}:`, err);
              return;
            }
            
            console.log(`  Members (${members.length}):`);
            members.forEach(member => {
              console.log(`    - ${member.name} (ID: ${member.user_id})`);
            });
            
            // Check messages for this group
            checkGroupMessages(group.group_id);
          }
        );
      });
    } else {
      console.log('No groups found in the database');
      closeConnection();
    }
  });
}

function checkGroupMessages(groupId) {
  // Try query with is_group first
  const queryWithIsGroup = `
    SELECT COUNT(*) as count FROM messages WHERE room_id = ? AND is_group = true
  `;
  
  db.query(queryWithIsGroup, [groupId], (err, results) => {
    if (err) {
      // If is_group column doesn't exist, try without it
      db.query('SELECT COUNT(*) as count FROM messages WHERE room_id = ?', [groupId], (err, results) => {
        if (err) {
          console.error(`Error checking messages for group ${groupId}:`, err);
        } else {
          console.log(`  Messages: ${results[0].count} (without is_group filter)`);
        }
        
        // This was the last group checked, close the connection
        if (groupId === lastGroupIdChecked) {
          closeConnection();
        }
      });
    } else {
      console.log(`  Messages: ${results[0].count} (with is_group filter)`);
      
      // This was the last group checked, close the connection
      if (groupId === lastGroupIdChecked) {
        closeConnection();
      }
    }
  });
}

let lastGroupIdChecked = null;

// Helper to set the last group ID checked
db.query('SELECT group_id FROM chat_groups ORDER BY id DESC LIMIT 1', (err, results) => {
  if (!err && results.length > 0) {
    lastGroupIdChecked = results[0].group_id;
  }
});

function closeConnection() {
  setTimeout(() => {
    console.log('\nClosing database connection');
    db.end();
  }, 1000);
} 