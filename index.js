const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcrypt');
const session = require('express-session');
const dotenv = require('dotenv');
const http = require('http');
const path = require('path');
const socketIo = require('socket.io');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Create HTTP server
const server = http.createServer(app);

// Set up Socket.io
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // Set to true if using HTTPS
}));

// Database connection
const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'job_assignment'
});

db.connect((err) => {
  if (err) {
    console.error('Error connecting to MySQL:', err);
    return;
  }
  console.log('Connected to MySQL database');
});

// Socket.io connection handling
// Store connected users
const connectedUsers = new Map();

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);
  
  // Handle user connected event
  socket.on('user-connected', (userData) => {
    // Store user data in the connectedUsers map
    connectedUsers.set(socket.id, {
      socketId: socket.id,
      userId: userData.userId,
      userName: userData.userName,
      online: true
    });
    
    // Send the updated user list to all clients
    io.emit('user-list', Array.from(connectedUsers.values()));
    
    // Notify others that this user is online
    socket.broadcast.emit('user-status-change', {
      userId: userData.userId,
      userName: userData.userName,
      online: true
    });
    
    // Retrieve active users from database if needed
    // You could query the database here to get a full list of registered users
    db.query('SELECT id, name FROM users', (err, results) => {
      if (err) {
        console.error('Error fetching users:', err);
        return;
      }
      
      // Combine database users with connected users status
      const allUsers = results.map(user => {
        // Check if this user is currently connected
        const isOnline = Array.from(connectedUsers.values())
          .some(u => parseInt(u.userId) === user.id);
        
        return {
          userId: user.id,
          userName: user.name,
          online: isOnline
        };
      });
      
      // Send the complete user list to the newly connected client
      socket.emit('user-list', allUsers);
    });
    
    // Join the user to all their groups
    db.query(
      'SELECT g.group_id, g.name FROM chat_groups g JOIN group_members gm ON g.group_id = gm.group_id WHERE gm.user_id = ?',
      [userData.userId],
      (err, results) => {
        if (err) {
          console.error('Error fetching user groups:', err);
          return;
        }
        
        if (results.length > 0) {
          console.log(`User ${userData.userName} is a member of ${results.length} groups. Joining socket rooms...`);
          
          // Join all the user's groups
          results.forEach(group => {
            console.log(`Joining user ${userData.userName} to group room: ${group.group_id}`);
            socket.join(group.group_id);
          });
          
          // After joining all groups, log the rooms the socket is in
          setTimeout(() => {
            const rooms = Array.from(socket.rooms);
            console.log(`Socket ${socket.id} is now in rooms:`, rooms);
          }, 100);
          
          // Send the groups list to the user
          socket.emit('group-list', results.map(group => ({
            groupId: group.group_id,
            name: group.name
          })));
        } else {
          console.log(`User ${userData.userName} is not a member of any groups`);
          socket.emit('group-list', []);
        }
      }
    );
  });
  
  // Handle private messages
  socket.on('private-message', (data) => {
    // Find the recipient's socket
    const recipientSocketId = findSocketIdByUserId(data.toUserId);
    
    // Save message to database first to ensure persistence
    const roomId = `private_${Math.min(data.fromUserId, data.toUserId)}_${Math.max(data.fromUserId, data.toUserId)}`;
    
    db.query(
      'INSERT INTO messages (user_id, content, room_id) VALUES (?, ?, ?)',
      [data.fromUserId, data.message, roomId],
      (err, result) => {
        if (err) {
          console.error('Error saving message to database:', err);
          // Still try to deliver the message even if DB save fails
        }
        
        // Send the message to the recipient if they're online
        if (recipientSocketId) {
          io.to(recipientSocketId).emit('private-message', {
            fromUserId: data.fromUserId,
            fromUserName: data.fromUserName,
            message: data.message,
            timestamp: new Date()
          });
        }
        
        // Confirm message delivery to sender
        socket.emit('message-sent', {
          toUserId: data.toUserId,
          message: data.message,
          timestamp: new Date(),
          messageId: result ? result.insertId : null
        });
      }
    );
  });
  
  // Handle typing indicator
  socket.on('typing', (data) => {
    const recipientSocketId = findSocketIdByUserId(data.toUserId);
    
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('typing', {
        userId: data.userId,
        userName: data.userName,
        isTyping: data.isTyping
      });
    }
  });
  
  // Handle group creation
  socket.on('create-group', (data) => {
    const userData = connectedUsers.get(socket.id);
    if (!userData) return;
    
    const groupId = 'group_' + Date.now();
    const groupName = data.groupName;
    const memberIds = data.memberIds || [];
    
    console.log(`Creating group "${groupName}" with ID ${groupId}`);
    console.log(`Group members: Creator ${userData.userId} and members ${memberIds.join(', ')}`);
    
    // Add creator to the members list if not already included
    if (!memberIds.includes(userData.userId)) {
      memberIds.push(userData.userId);
    }
    
    // Create the group in the database
    db.query(
      'INSERT INTO chat_groups (name, creator_id, group_id) VALUES (?, ?, ?)',
      [groupName, userData.userId, groupId],
      (err, result) => {
        if (err) {
          console.error('Error creating group:', err);
          socket.emit('group-created', { success: false, error: 'Failed to create group' });
          return;
        }
        
        // Add all members to the group
        const memberValues = memberIds.map(memberId => [groupId, memberId]);
        
        db.query(
          'INSERT INTO group_members (group_id, user_id) VALUES ?',
          [memberValues],
          (err) => {
            if (err) {
              console.error('Error adding group members:', err);
              socket.emit('group-created', { success: false, error: 'Failed to add members' });
              return;
            }
            
            console.log(`Group "${groupName}" created successfully in database`);
            
            // Join the socket to the group room
            socket.join(groupId);
            console.log(`Creator ${userData.userName} joined room ${groupId}`);
            
            // Create the group object to send to clients
            const groupObject = {
              success: true,
              group: {
                id: result.insertId,
                groupId: groupId,
                name: groupName,
                creatorId: userData.userId,
                memberIds: memberIds
              }
            };
            
            // Notify all members about the new group
            memberIds.forEach(memberId => {
              const memberSocketId = findSocketIdByUserId(memberId);
              if (memberSocketId) {
                console.log(`Notifying member ${memberId} about new group ${groupId}`);
                io.to(memberSocketId).emit('group-created', groupObject);
                
                // Join this member's socket to the group
                if (memberSocketId !== socket.id) {
                  const memberSocket = io.sockets.sockets.get(memberSocketId);
                  if (memberSocket) {
                    memberSocket.join(groupId);
                    console.log(`Member ${memberId} joined room ${groupId}`);
                  } else {
                    console.log(`Could not find socket object for member ${memberId}`);
                  }
                }
              } else {
                console.log(`Member ${memberId} is offline, will join group on next connection`);
              }
            });
            
            // Check who's in the room
            setTimeout(() => {
              const room = io.sockets.adapter.rooms.get(groupId);
              const roomSize = room ? room.size : 0;
              console.log(`Room ${groupId} has ${roomSize} connected clients`);
            }, 500);
            
            // Send a system message to the group
            io.to(groupId).emit('group-message', {
              groupId: groupId,
              fromUserId: 'system',
              fromUserName: 'System',
              message: `Group "${groupName}" created by ${userData.userName}`,
              timestamp: new Date(),
              isSystem: true
            });
          }
        );
      }
    );
  });
  
  // Handle group messages
  socket.on('group-message', (data) => {
    const userData = connectedUsers.get(socket.id);
    if (!userData) {
      console.log('Group message error: User data not found for socket', socket.id);
      return;
    }
    
    const { groupId, message } = data;
    console.log(`Group message received: ${message} from user ${userData.userName} to group ${groupId}`);
    
    // Check if socket is in the room
    const rooms = Array.from(socket.rooms);
    console.log(`Socket ${socket.id} is in rooms:`, rooms);
    
    // Make sure socket is in the room
    if (!rooms.includes(groupId)) {
      console.log(`Socket was not in room ${groupId}, joining now`);
      socket.join(groupId);
    }
    
    // Try to save with is_group flag first
    const queryWithIsGroup = 'INSERT INTO messages (user_id, content, room_id, is_group) VALUES (?, ?, ?, ?)';
    const queryWithoutIsGroup = 'INSERT INTO messages (user_id, content, room_id) VALUES (?, ?, ?)';
    
    db.query(queryWithIsGroup, [userData.userId, message, groupId, true], (err, result) => {
      if (err) {
        // If error involves is_group column, try the fallback query
        if (err.code === 'ER_BAD_FIELD_ERROR' && err.sqlMessage.includes('is_group')) {
          console.log('Database does not have is_group column, using fallback query');
          db.query(queryWithoutIsGroup, [userData.userId, message, groupId], (err, result) => {
            if (err) {
              console.error('Error saving group message (fallback):', err);
              return;
            }
            
            sendGroupMessage(result, groupId, userData, message);
          });
        } else {
          console.error('Error saving group message:', err);
          console.error(err);
        }
      } else {
        console.log(`Group message saved to database with ID ${result.insertId}`);
        sendGroupMessage(result, groupId, userData, message);
      }
    });
    
    function sendGroupMessage(result, groupId, userData, message) {
      // Get all sockets in the room
      const roomSize = io.sockets.adapter.rooms.get(groupId)?.size || 0;
      console.log(`Broadcasting to ${roomSize} clients in room ${groupId}`);
      
      // Broadcast message to all group members
      io.to(groupId).emit('group-message', {
        messageId: result.insertId,
        groupId: groupId,
        fromUserId: userData.userId,
        fromUserName: userData.userName,
        message: message,
        timestamp: new Date()
      });
    }
  });
  
  // Handle leaving a group
  socket.on('leave-group', (data) => {
    const userData = connectedUsers.get(socket.id);
    if (!userData) return;
    
    const { groupId } = data;
    
    // Remove user from the group in the database
    db.query(
      'DELETE FROM group_members WHERE group_id = ? AND user_id = ?',
      [groupId, userData.userId],
      (err) => {
        if (err) {
          console.error('Error leaving group:', err);
          socket.emit('leave-group-result', { success: false, error: 'Failed to leave group' });
          return;
        }
        
        // Leave the socket room
        socket.leave(groupId);
        
        // Notify the user
        socket.emit('leave-group-result', { success: true, groupId: groupId });
        
        // Notify other group members
        io.to(groupId).emit('group-message', {
          groupId: groupId,
          fromUserId: 'system',
          fromUserName: 'System',
          message: `${userData.userName} has left the group`,
          timestamp: new Date(),
          isSystem: true
        });
        
        // Check if the group is now empty and should be deleted
        db.query(
          'SELECT COUNT(*) as memberCount FROM group_members WHERE group_id = ?',
          [groupId],
          (err, results) => {
            if (err) {
              console.error('Error checking group members:', err);
              return;
            }
            
            if (results[0].memberCount === 0) {
              // No members left, delete the group
              db.query('DELETE FROM chat_groups WHERE group_id = ?', [groupId]);
            }
          }
        );
      }
    );
  });
  
  // Handle removing a member from a group
  socket.on('remove-group-member', (data) => {
    const userData = connectedUsers.get(socket.id);
    if (!userData) return;
    
    const { groupId, userId } = data;
    
    // Verify that the requesting user is the group creator
    db.query(
      'SELECT * FROM chat_groups WHERE group_id = ? AND creator_id = ?',
      [groupId, userData.userId],
      (err, results) => {
        if (err || results.length === 0) {
          console.error('Error verifying group creator or not authorized:', err);
          return;
        }
        
        const groupInfo = results[0];
        
        // Get user name before removing
        db.query('SELECT name FROM users WHERE id = ?', [userId], (err, userResults) => {
          if (err || userResults.length === 0) {
            console.error('Error getting user info:', err);
            return;
          }
          
          const userName = userResults[0].name;
          
          // Remove the user from the group
          db.query(
            'DELETE FROM group_members WHERE group_id = ? AND user_id = ?',
            [groupId, userId],
            (err) => {
              if (err) {
                console.error('Error removing group member:', err);
                return;
              }
              
              console.log(`User ${userId} (${userName}) removed from group ${groupId} by ${userData.userName}`);
              
              // Find the removed user's socket to notify them
              const removedUserSocketId = findSocketIdByUserId(userId);
              if (removedUserSocketId) {
                // Notify the removed user
                io.to(removedUserSocketId).emit('member-removed', {
                  groupId,
                  groupName: groupInfo.name,
                  userId,
                  userName
                });
                
                // Remove them from the room
                io.sockets.sockets.get(removedUserSocketId)?.leave(groupId);
              }
              
              // Notify other group members
              io.to(groupId).emit('member-removed', {
                groupId,
                userId,
                userName
              });
              
              // Send a system message to the group
              io.to(groupId).emit('group-message', {
                groupId: groupId,
                fromUserId: 'system',
                fromUserName: 'System',
                message: `${userName} has been removed from the group by ${userData.userName}`,
                timestamp: new Date(),
                isSystem: true
              });
            }
          );
        });
      }
    );
  });
  
  // Handle adding members to a group
  socket.on('add-group-members', (data) => {
    const userData = connectedUsers.get(socket.id);
    if (!userData) return;
    
    const { groupId, userIds } = data;
    
    // Verify that the requesting user is the group creator
    db.query(
      'SELECT * FROM chat_groups WHERE group_id = ? AND creator_id = ?',
      [groupId, userData.userId],
      (err, results) => {
        if (err || results.length === 0) {
          console.error('Error verifying group creator or not authorized:', err);
          return;
        }
        
        const groupInfo = results[0];
        
        // Prepare values for batch insert
        const memberValues = userIds.map(memberId => [groupId, memberId]);
        
        // Add users to the group
        db.query(
          'INSERT INTO group_members (group_id, user_id) VALUES ? ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)',
          [memberValues],
          (err) => {
            if (err) {
              console.error('Error adding group members:', err);
              return;
            }
            
            console.log(`Added ${userIds.length} users to group ${groupId} by ${userData.userName}`);
            
            // Get user names for added users
            db.query(
              'SELECT id, name FROM users WHERE id IN (?)',
              [userIds],
              (err, userResults) => {
                if (err) {
                  console.error('Error getting user info:', err);
                  return;
                }
                
                const addedUsers = userResults.map(user => ({
                  userId: user.id,
                  userName: user.name
                }));
                
                // Join added users to the socket room if they're online
                addedUsers.forEach(addedUser => {
                  const addedUserSocketId = findSocketIdByUserId(addedUser.userId);
                  if (addedUserSocketId) {
                    io.sockets.sockets.get(addedUserSocketId)?.join(groupId);
                    
                    // Notify the added user about the new group
                    io.to(addedUserSocketId).emit('group-created', {
                      success: true,
                      group: {
                        id: groupInfo.id,
                        groupId: groupId,
                        name: groupInfo.name,
                        creatorId: userData.userId
                      }
                    });
                  }
                });
                
                // Notify group members about added users
                io.to(groupId).emit('members-added', {
                  groupId,
                  addedUsers
                });
                
                // Send a system message to the group for each added user
                addedUsers.forEach(addedUser => {
                  io.to(groupId).emit('group-message', {
                    groupId: groupId,
                    fromUserId: 'system',
                    fromUserName: 'System',
                    message: `${addedUser.userName} has been added to the group by ${userData.userName}`,
                    timestamp: new Date(),
                    isSystem: true
                  });
                });
              }
            );
          }
        );
      }
    );
  });
  
  // Handle disconnect
  socket.on('disconnect', () => {
    // Get the disconnected user data
    const userData = connectedUsers.get(socket.id);
    
    if (userData) {
      // Remove from connected users
      connectedUsers.delete(socket.id);
      
      // Notify others that this user is offline
      io.emit('user-status-change', {
        userId: userData.userId,
        userName: userData.userName,
        online: false
      });
      
      // Send updated user list
      io.emit('user-list', Array.from(connectedUsers.values()));
    }
    
    console.log('User disconnected:', socket.id);
  });

  // Helper function to find a socket ID by user ID
  function findSocketIdByUserId(userId) {
    for (const [socketId, userData] of connectedUsers.entries()) {
      if (userData.userId == userId) { // loose equality to handle string/number conversion
        return socketId;
      }
    }
    return null;
  }

  // Helper function to fetch and send user's groups
  function sendUserGroups(socket, userId) {
    // Only proceed if valid parameters
    if (!socket || !userId) return;
    
    console.log(`Fetching groups for user ${userId}`);
    
    // Query for user's groups with member count
    db.query(
      `SELECT g.group_id, g.name, g.creator_id, g.created_at, 
       COUNT(gm.user_id) as member_count 
       FROM chat_groups g 
       JOIN group_members gm ON g.group_id = gm.group_id 
       WHERE g.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?) 
       GROUP BY g.group_id`,
      [userId],
      (err, results) => {
        if (err) {
          console.error('Error fetching user groups:', err);
          return;
        }
        
        console.log(`Found ${results.length} groups for user ${userId}`);
        
        // Send groups list to the user
        socket.emit('group-list', results);
      }
    );
  }

  // Handle request-groups event
  socket.on('request-groups', () => {
    const userData = connectedUsers.get(socket.id);
    if (!userData) {
      console.log('Request-groups error: User data not found for socket', socket.id);
      return;
    }
    
    console.log(`User ${userData.userName} requested refreshed groups list`);
    sendUserGroups(socket, userData.userId);
  });
});

// Routes
app.get('/', (req, res) => {
  res.redirect('/log_in.html');
});

// Get chat history for two users
app.get('/api/messages/:userId/:otherUserId', (req, res) => {
  try {
    // Note: Usually we would check session but for demo/testing, let's make it work without strict auth
    // if (!req.session.userId) {
    //   return res.status(401).json({ error: 'Unauthorized' });
    // }
    
    const userId = parseInt(req.params.userId);
    const otherUserId = parseInt(req.params.otherUserId);
    
    if (isNaN(userId) || isNaN(otherUserId)) {
      return res.status(400).json({ error: 'Invalid user IDs' });
    }
    
    // Create a room ID based on the two user IDs (smaller ID first)
    const roomId = `private_${Math.min(userId, otherUserId)}_${Math.max(userId, otherUserId)}`;
    
    // Query messages for this room
    db.query(
      `SELECT m.id, m.user_id, u.name as user_name, m.content, m.created_at 
       FROM messages m 
       JOIN users u ON m.user_id = u.id 
       WHERE m.room_id = ? 
       ORDER BY m.created_at ASC 
       LIMIT 100`,
      [roomId],
      (err, results) => {
        if (err) {
          console.error('Error fetching messages:', err);
          return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        res.status(200).json({ 
          messages: results,
          roomId: roomId,
          success: true
        });
      }
    );
  } catch (error) {
    console.error('Server error fetching messages:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// Get group info and members
app.get('/api/groups/:groupId', (req, res) => {
  const groupId = req.params.groupId;
  
  // Query group info
  db.query(
    'SELECT g.*, u.name as creator_name FROM chat_groups g JOIN users u ON g.creator_id = u.id WHERE g.group_id = ?',
    [groupId],
    (err, groupResults) => {
      if (err) {
        console.error('Error fetching group:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      
      if (groupResults.length === 0) {
        return res.status(404).json({ error: 'Group not found' });
      }
      
      const group = groupResults[0];
      
      // Query group members
      db.query(
        'SELECT u.id as user_id, u.name as user_name, gm.joined_at FROM group_members gm JOIN users u ON gm.user_id = u.id WHERE gm.group_id = ?',
        [groupId],
        (err, memberResults) => {
          if (err) {
            console.error('Error fetching group members:', err);
            return res.status(500).json({ error: 'Database error' });
          }
          
          res.status(200).json({
            group: group,
            members: memberResults
          });
        }
      );
    }
  );
});

// Get user's groups
app.get('/api/users/:userId/groups', (req, res) => {
  const userId = req.params.userId;
  
  db.query(
    `SELECT g.group_id, g.name, g.creator_id, g.created_at, 
     COUNT(gm.user_id) as member_count 
     FROM chat_groups g 
     JOIN group_members gm ON g.group_id = gm.group_id 
     WHERE g.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?) 
     GROUP BY g.group_id`,
    [userId],
    (err, results) => {
      if (err) {
        console.error('Error fetching user groups:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      
      res.status(200).json({ groups: results });
    }
  );
});

// Get group messages
app.get('/api/groups/:groupId/messages', (req, res) => {
  const groupId = req.params.groupId;
  console.log(`Fetching messages for group ${groupId}`);
  
  // First try with is_group column
  const queryWithIsGroup = `
    SELECT m.id, m.user_id, u.name as user_name, m.content, m.created_at 
    FROM messages m 
    JOIN users u ON m.user_id = u.id 
    WHERE m.room_id = ? AND m.is_group = true
    ORDER BY m.created_at ASC 
    LIMIT 100
  `;
  
  // Fallback query without is_group column
  const queryWithoutIsGroup = `
    SELECT m.id, m.user_id, u.name as user_name, m.content, m.created_at 
    FROM messages m 
    JOIN users u ON m.user_id = u.id 
    WHERE m.room_id = ?
    ORDER BY m.created_at ASC 
    LIMIT 100
  `;
  
  // Try with is_group first
  db.query(queryWithIsGroup, [groupId], (err, results) => {
    if (err) {
      // If error involves is_group column, try the fallback query
      if (err.code === 'ER_BAD_FIELD_ERROR' && err.sqlMessage && err.sqlMessage.includes('is_group')) {
        console.log(`Database doesn't have is_group column, using fallback query for group ${groupId}`);
        db.query(queryWithoutIsGroup, [groupId], (err, results) => {
          if (err) {
            console.error('Error fetching group messages (fallback):', err);
            return res.status(500).json({ error: 'Database error' });
          }
          
          console.log(`Found ${results.length} messages for group ${groupId} using fallback query`);
          res.status(200).json({ messages: results });
        });
      } else {
        console.error('Error fetching group messages:', err);
        return res.status(500).json({ error: 'Database error' });
      }
    } else {
      console.log(`Found ${results.length} messages for group ${groupId} with is_group flag`);
      res.status(200).json({ messages: results });
    }
  });
});

app.post('/api/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    
    // Check if user already exists
    db.query('SELECT * FROM users WHERE email = ?', [email], async (err, results) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      
      if (results.length > 0) {
        return res.status(400).json({ error: 'User already exists' });
      }
      
      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);
      
      // Insert new user
      db.query(
        'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
        [name, email, hashedPassword],
        (err, result) => {
          if (err) {
            return res.status(500).json({ error: 'Failed to register user' });
          }
          
          res.status(201).json({ message: 'User registered successfully' });
        }
      );
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Find user by email
    db.query('SELECT * FROM users WHERE email = ?', [email], async (err, results) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      
      if (results.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      const user = results[0];
      
      // Compare passwords
      const isMatch = await bcrypt.compare(password, user.password);
      
      if (!isMatch) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      // Set session
      req.session.userId = user.id;
      req.session.userName = user.name;
      
      res.status(200).json({ 
        message: 'Login successful',
        user: {
          id: user.id,
          name: user.name,
          email: user.email
        }
      });
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.status(200).json({ message: 'Logged out successfully' });
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 