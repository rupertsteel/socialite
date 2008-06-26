 // Todo:
 // = Modularize
 // ---- Watches
 // - Download list of current top links and auto-apply to pages
 // + Save button
 // + Button preferences
 // - Login detection/button
 // - Display score
 // - Display subreddit
 // + Persistence Options
 // + Better error handling/retry
 // - Submit link command
 // - Make roll-in an option
 
 // Outstanding issues:
 // + Raw images seem to not be handled by DOMContentLoaded
 // + Toolbar opening lag
 // + Open comments in new tab
 // + Popup blocker bar
 // + Preserve after back-forward
 // + Reopen bar
 // + Some links still not working
 // - Link title alignment off
 // - m.reddit.com support (Pickegnome)
 // - Handle RSS readers
 // - Disable on fullscreen

REDDIT_LIKE_INACTIVE_IMAGE = "chrome://socialite/content/reddit_aupgray.png"
REDDIT_LIKE_ACTIVE_IMAGE = "chrome://socialite/content/reddit_aupmod.png"
REDDIT_DISLIKE_INACTIVE_IMAGE = "chrome://socialite/content/reddit_adowngray.png"
REDDIT_DISLIKE_ACTIVE_IMAGE = "chrome://socialite/content/reddit_adownmod.png"

RETRY_COUNT = 3;
RETRY_DELAY = 5000;

Components.utils.import("resource://socialite/preferences.jsm");
Components.utils.import("resource://socialite/debug.jsm");
Components.utils.import("resource://socialite/utils/action/action.jsm");
Components.utils.import("resource://socialite/utils/action/retry_action.jsm");
Components.utils.import("resource://socialite/utils/hitch.jsm");
Components.utils.import("resource://socialite/utils/oneshot.jsm");
reddit = Components.utils.import("resource://socialite/reddit/reddit.jsm");
Components.utils.import("resource://socialite/reddit/link_info.jsm");

var alertsService = Components.classes["@mozilla.org/alerts-service;1"]
                    .getService(Components.interfaces.nsIAlertsService);

// ---

const STATE_START = Components.interfaces.nsIWebProgressListener.STATE_START;
const STATE_STOP = Components.interfaces.nsIWebProgressListener.STATE_STOP;
var SocialiteProgressListener =
{
  QueryInterface: function(aIID) {
   if (aIID.equals(Components.interfaces.nsIWebProgressListener) ||
       aIID.equals(Components.interfaces.nsISupportsWeakReference) ||
       aIID.equals(Components.interfaces.nsISupports))
     return this;
   throw Components.results.NS_NOINTERFACE;
  },

  onStateChange: function(aWebProgress, aRequest, aFlag, aStatus) {return 0;},

  onLocationChange: function(aProgress, aRequest, aURI) {
    var window = aProgress.DOMWindow;
    
    if (window == window.top) {
      debug_log("SocialiteProgressListener", "onLocationChange (loading): " + aProgress.DOMWindow.location.href);
      Socialite.linkStartLoad(window, aProgress.isLoadingDocument);
    }
  },
  
  onProgressChange: function() {return 0;},
  onStatusChange: function() {return 0;},
  onSecurityChange: function() {return 0;},
}

// ---

var Socialite = new Object();

Socialite.init = function() {
  this.initialized = false;
  window.addEventListener("load", hitchHandler(this, "onLoad"), false);
  window.addEventListener("unload", hitchHandler(this, "onUnload"), false);
};

Socialite.onLoad = function() {
  // initialization code
  this.strings = document.getElementById("socialite-strings");
  
  this.tabBrowser = document.getElementById("content");
  this.appContent = document.getElementById("appcontent");
  
  this.linksWatched = {};
  
  // FIFO queue for removing old watched links
  this.linksWatchedQueue = [];
  this.linksWatchedLimit = 100;
  
  // Authentication hash
  this.redditModHash = null;
  
  this.tabBrowser.addEventListener("DOMContentLoaded", hitchHandler(this, "contentLoad"), false);
  
  // Watch for new tabs to add progress listener to them
  this.tabBrowser.addEventListener("TabOpen", hitchHandler(this, "tabOpened"), false);
  this.tabBrowser.addEventListener("TabClose", hitchHandler(this, "tabClosed"), false);
  
  // Add progress listener to tabbrowser. This fires progress events for the current tab.
  this.setupProgressListener(this.tabBrowser);
  
  this.initialized = true;
};

Socialite.setupProgressListener = function(browser) {
  debug_log("main", "Progress listener added.");
  
  browser.addProgressListener(SocialiteProgressListener,  Components.interfaces.nsIWebProgress.NOTIFY_ALL);
};

Socialite.unsetProgressListener = function(browser) {
  debug_log("main", "Progress listener removed.");
    
  browser.removeProgressListener(SocialiteProgressListener);
};

Socialite.onUnload = function() {
  // Remove remaining progress listeners.
  
  this.unsetProgressListener(this.tabBrowser);
};

Socialite.tabOpened = function(e) {
  var browser = e.originalTarget.linkedBrowser;
  var win = browser.contentWindow;
  
  debug_log("main", "Tab opened: " + win.location.href);
  
  this.linkStartLoad(win);
}

Socialite.tabClosed = function(e) {
  var browser = e.originalTarget.linkedBrowser;
  
  debug_log("main", "Tab closed: " + browser.contentWindow.location.href);
}

Socialite.contentLoad = function(e) {
  var doc = e.originalTarget;
  
  if (doc instanceof HTMLDocument) {
    var win = doc.defaultView;
    
    if (win.location.hostname.match(/reddit\.com$/) && win == win.top) {
      // Iterate over each article link and register event listener
      var res = doc.evaluate('//a[@class="title loggedin"]', doc.documentElement, null, XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE, null );
      
      for (var i=0; i < res.snapshotLength; i++) {
        var siteLink = res.snapshotItem(i);
        siteLink.addEventListener("mouseup", hitchHandler(this, "linkClicked"), false);
        //siteLink.style.color = "red";
      }
      
      debug_log("main", "Added click handlers to " + res.snapshotLength + " links on " + win.location.href);
      
      // Snarf the authentication hash using wrappedJSObject
      this.redditModHash = win.wrappedJSObject.modhash
    }
  }
};

Socialite.linkClicked = function(e) {
  var link = e.target;
  var doc = link.ownerDocument;
  var browser = this.tabBrowser.getBrowserForDocument(doc);
    
  // Remove title_ from title_XX_XXXXX
  var linkURL   = link.href;
  var linkID    = link.id.slice(6);
  var linkTitle = link.textContent;
  
  var linkInfo = new LinkInfo(linkURL, linkID, linkTitle);
  
  // Get some "preloaded" information from the page while we can.
  var linkLike            = doc.getElementById("up_"+linkInfo.id);
  var linkLikeActive      = /upmod/.test(linkLike.className);
  
  var linkDislike         = doc.getElementById("down_"+linkInfo.id);
  var linkDislikeActive   = /downmod/.test(linkDislike.className);

  if (linkLikeActive) {
    linkInfo.state.isLiked  = true;
  } else if (linkDislikeActive) {
    linkInfo.state.isLiked  = false;
  } else {
    linkInfo.state.isLiked  = null;
  }

  var linkComments        = doc.getElementById("comment_"+linkInfo.id);
  linkInfo.commentURL     = linkComments.href;
  
  var commentNum          = /((\d+)\s)?comment[s]?/.exec(linkComments.textContent)[2];
  if (commentNum) {
    linkInfo.state.commentCount = parseInt(commentNum);
  } else {
    linkInfo.state.commentCount = 0;
  }
  
  var linkSave            = doc.getElementById("save_"+linkInfo.id+"_a");
  var linkUnsave          = doc.getElementById("unsave_"+linkInfo.id+"_a");
  
  if (linkSave != null) {
    // If there's a save link
    // Whether it's clicked
    linkInfo.linkIsSaved = (linkSave.style.display == "none");
  } else if (linkUnsave != null) {
    // If there's an unsave link (assumption)
    // Whether it's not clicked
    linkInfo.linkIsSaved = (linkUnsave.style.display != "none");
  } else {
    // No save or unsave link present -- this shouldn't happen, as far as I know.
    throw "Unexpected save link absence.";
  }
  
  linkInfo.updateUIState();
  
  debug_log(linkInfo.id, "Clicked");
  this.watchLink(link.href, linkInfo);
};

Socialite.watchLink = function(href, linkInfo) {
  if (this.linksWatchedQueue.length == this.linksWatchedLimit) {
    // Stop watching the oldest link
    delete this.linksWatched[this.linksWatchedQueue.shift()];
  }

  this.linksWatched[href] = linkInfo;
  this.linksWatchedQueue.push(href);
  
  debug_log("main", "Watching: " + href);
}

Socialite.linkStartLoad = function(win, isLoading) {
  var href = win.location.href;

  if (href in this.linksWatched) {
    var linkInfo = this.linksWatched[href];
    var browser = this.tabBrowser.getBrowserForDocument(win.document);
    
    debug_log(linkInfo.id, "Started loading");
  
    this.redditUpdateLinkInfo(linkInfo);
  
    // Show the banner, without allowing actions yet
    this.showNotificationBox(browser, linkInfo, isLoading);
  }
}

Socialite.redditUpdateLinkInfo = function(linkInfo) {
  linkInfo.update(
    hitchThis(this, function success(action) {
      // Only update the UI if the update started after the last user-caused UI update.
      if (action.startTime >= linkInfo.uiState.lastUpdated) {
        debug_log(linkInfo.id, "Updating UI");
        linkInfo.updateUIState();
        this.updateButtons(linkInfo);
      } else {
        debug_log(linkInfo.id, "UI changed since update request, not updating UI");
      }
    }),
    retryAction(RETRY_COUNT, RETRY_DELAY, null, null,
      hitchHandler(this, "failureNotification"))
  ).perform();
}

Socialite.failureNotification = function(r, action) {
  var text;
  
  if (r.status != 200) {
    text = "Unexpected HTTP status " + r.status + " recieved (" + action.name + ")";
  } else {
    text = "The requested action failed (" + action.name + ")";
  }
  
  alertsService.showAlertNotification(
    "chrome://global/skin/icons/Error.png",
    "Socialite Connection Error",
    text, 
    null, null, null, "socialite-failure");
    
  // Finally, update the buttons to make sure their state matches the data.
  this.updateButtons(linkInfo);
}
  
Socialite.showNotificationBox = function(browser, linkInfo, isNewPage) {
  var notificationBox = this.tabBrowser.getNotificationBox(browser);
  var notificationName = "socialite-header"+"-"+linkInfo.id;
  
  var toRemove = null;    
  var curNotifications = notificationBox.allNotifications;
  for (var i=0; i < curNotifications.length; i++) {
    var n = curNotifications.item(i);
    
    if (n.value == notificationName) {
      debug_log(linkInfo.id, "Notification box already exists");
      
      if (isNewPage && (SocialitePrefs.getIntPref("persistmode") == 1)) {
        n.persistence = SocialitePrefs.getIntPref("persistlength");
        debug_log(linkInfo.id, "Reset notification persistence count");
      }
      
      return;
    }
    
    if (n.value.match(/^socialite-header/)) {
      debug_log(linkInfo.id, "Old notification found, queued to remove.");
      toRemove = n;
    }
  }
  
  var notification = notificationBox.appendNotification(
    linkInfo.title,
    notificationName,
    "chrome://socialite/content/reddit_favicon.ico",
    notificationBox.PRIORITY_INFO_MEDIUM,
    []
  );
  
  // Remove the notification after appending the new one, so we get a smooth in-place slide.
  if (toRemove) {
    notificationBox.removeNotification(toRemove);
  }
  
  // Ahoy! Commence the XUL hackage!
  // Let's make this notification a bit cooler.
  
  // XXX is this an okay approach? (compatibility, is there a better way, etc)
  
  var roothbox = notification.boxObject.firstChild;
  var details = roothbox.getElementsByAttribute("anonid", "details")[0];
  var messageImage = roothbox.getElementsByAttribute("anonid", "messageImage")[0];
  var messageText = roothbox.getElementsByAttribute("anonid", "messageText")[0];
  
  // Muahahahahaha
  var siteLink = document.createElement("label");
  siteLink.setAttribute("id", "socialite_site_link_"+linkInfo.id);
  siteLink.setAttribute("value", "reddit");
  siteLink.setAttribute("class", "text-link");
  siteLink.setAttribute("flex", true);
  siteLink.setAttribute("hidden", !SocialitePrefs.getBoolPref("showlink"));
  siteLink.addEventListener("click", hitchHandler(this, "siteLinkClicked"), false);
  messageImage.addEventListener("click", hitchHandler(this, "siteLinkClicked"), false);
  details.insertBefore(siteLink, messageText);
  
  // XUL hackage done.    
  
  var buttonLike = document.createElement("button");
  buttonLike.setAttribute("id", "socialite_mod_up_"+linkInfo.id);
  buttonLike.setAttribute("type", "checkbox");
  buttonLike.setAttribute("label", this.strings.getString("likeit"));
  buttonLike.setAttribute("accesskey", this.strings.getString("likeit.accesskey"));
  buttonLike.setAttribute("image", REDDIT_LIKE_INACTIVE_IMAGE);
  buttonLike.setAttribute("autoCheck", "false");
  buttonLike.addEventListener("click", hitchHandler(this, "buttonLikeClicked", linkInfo), false);
  notification.appendChild(buttonLike);
  linkInfo.buttons.buttonLike = buttonLike;
  
  var buttonDislike = document.createElement("button");
  buttonDislike.setAttribute("id", "socialite_mod_down_"+linkInfo.id);
  buttonDislike.setAttribute("type", "checkbox");
  buttonDislike.setAttribute("label", this.strings.getString("dislikeit"));
  buttonDislike.setAttribute("accesskey", this.strings.getString("dislikeit.accesskey"));
  buttonDislike.setAttribute("image", REDDIT_DISLIKE_INACTIVE_IMAGE);
  buttonDislike.setAttribute("autoCheck", "false");
  notification.appendChild(buttonDislike);
  buttonDislike.addEventListener("click", hitchHandler(this, "buttonDislikeClicked", linkInfo), false);
  linkInfo.buttons.buttonDislike = buttonDislike;
  
  var buttonComments = document.createElement("button");
  buttonComments.setAttribute("id", "socialite_comments_"+linkInfo.id);
  buttonComments.setAttribute("accesskey", this.strings.getString("comments.accesskey"));
  buttonComments.setAttribute("hidden", !SocialitePrefs.getBoolPref("showcomments"));
  buttonComments.addEventListener("click", hitchHandler(this, "buttonCommentsClicked", linkInfo), false);
  notification.appendChild(buttonComments);
  linkInfo.buttons.buttonComments = buttonComments;
  
  var buttonSave = document.createElement("button");
  buttonSave.setAttribute("id", "socialite_save_"+linkInfo.id);
  buttonSave.setAttribute("hidden", !SocialitePrefs.getBoolPref("showsave"));
  buttonSave.addEventListener("click", hitchHandler(this, "buttonSaveClicked", linkInfo), false);
  notification.appendChild(buttonSave);
  linkInfo.buttons.buttonSave = buttonSave;
  
  var buttonRandom = document.createElement("button");
  buttonRandom.setAttribute("id", "socialite_random_"+linkInfo.id);
  buttonRandom.setAttribute("label", this.strings.getString("random"));
  buttonRandom.setAttribute("accesskey", this.strings.getString("random.accesskey"));
  buttonRandom.setAttribute("hidden", !SocialitePrefs.getBoolPref("showrandom"));
  buttonRandom.addEventListener("click", hitchHandler(this, "buttonRandomClicked"), false);
  notification.appendChild(buttonRandom);
  linkInfo.buttons.buttonRandom = buttonRandom;
  
  this.updateButtons(linkInfo);

  // Persistence
  var persistMode = SocialitePrefs.getIntPref("persistmode");
  if (persistMode == 0) {
    notification.persistence = 0;
  } else if (persistMode == 1) {
    notification.persistence = SocialitePrefs.getIntPref("persistlength");
  } else if (persistMode == 2) {
    notification.persistence = -1;
  }   
  
  debug_log(linkInfo.id, "Notification box created");
  
  linkInfo.notification = notification;
};

Socialite.updateLikeButtons = function(buttons, isLiked) {
  if (isLiked == true) {
    buttons.buttonLike.setAttribute("image", REDDIT_LIKE_ACTIVE_IMAGE);
    buttons.buttonLike.setAttribute("checked", true);
  } else {
    buttons.buttonLike.setAttribute("image", REDDIT_LIKE_INACTIVE_IMAGE);
    buttons.buttonLike.setAttribute("checked", false);
  }
  
  if (isLiked == false) {
    buttons.buttonDislike.setAttribute("image", REDDIT_DISLIKE_ACTIVE_IMAGE);
    buttons.buttonDislike.setAttribute("checked", true);
  } else {
    buttons.buttonDislike.setAttribute("image", REDDIT_DISLIKE_INACTIVE_IMAGE);
    buttons.buttonDislike.setAttribute("checked", false);
  }
};

Socialite.updateSaveButton = function(buttons, isSaved) {
  if (isSaved) {
    buttons.buttonSave.setAttribute("label", this.strings.getString("unsave"));
    buttons.buttonSave.setAttribute("accesskey", this.strings.getString("unsave.accesskey"));
  } else {
    buttons.buttonSave.setAttribute("label", this.strings.getString("save"));
    buttons.buttonSave.setAttribute("accesskey", this.strings.getString("save.accesskey"));
  }
}

Socialite.updateCommentsButton = function(buttons, commentCount) {
  buttons.buttonComments.setAttribute("label", this.strings.getFormattedString("comments", [commentCount.toString()]));
}

Socialite.updateButtons = function(linkInfo) {
  if (linkInfo.modActive) {
    linkInfo.buttons.buttonLike.setAttribute("disabled", false);
    linkInfo.buttons.buttonDislike.setAttribute("disabled", false);
    linkInfo.buttons.buttonSave.setAttribute("disabled", false);
  } else {
    linkInfo.buttons.buttonLike.setAttribute("disabled", true);
    linkInfo.buttons.buttonDislike.setAttribute("disabled", true);
    linkInfo.buttons.buttonSave.setAttribute("disabled", true);
  }
  
  this.updateLikeButtons(linkInfo.buttons, linkInfo.uiState.isLiked);
  this.updateCommentsButton(linkInfo.buttons, linkInfo.uiState.commentCount);
  this.updateSaveButton(linkInfo.buttons, linkInfo.uiState.isSaved);
  
  debug_log(linkInfo.id, "Updated buttons");
}

Socialite.buttonLikeClicked = function(linkInfo, e) {
  if (linkInfo.uiState.isLiked == true) {
    linkInfo.uiState.isLiked = null;
  } else {
    linkInfo.uiState.isLiked = true;
  }
  linkInfo.uiState.updated();

  // Provide instant feedback before sending
  this.updateLikeButtons(linkInfo.buttons, linkInfo.uiState.isLiked);
  
  // Submit the vote, and then update state.
  // (proceeding after each AJAX call completes)
  var submit = new reddit.vote(
    hitchHandler(this, "redditUpdateLinkInfo", linkInfo),
    retryAction(RETRY_COUNT, RETRY_DELAY, null, null,
      hitchHandler(this, "failureNotification"))
  );    
    
  submit.perform(this.redditModHash, linkInfo.id, linkInfo.uiState.isLiked);
};

Socialite.buttonDislikeClicked = function(linkInfo, e) {
  if (linkInfo.uiState.isLiked == false) {
    linkInfo.uiState.isLiked = null;
  } else {
    linkInfo.uiState.isLiked = false;
  }
  linkInfo.uiState.updated();
  
  // Provide instant feedback before sending
  this.updateLikeButtons(linkInfo.buttons, linkInfo.uiState.isLiked);
  
  // Submit the vote, and then update state.
  // (proceeding after the AJAX call completes)
  var submit = new reddit.vote(
    hitchHandler(this, "redditUpdateLinkInfo", linkInfo),
    retryAction(RETRY_COUNT, RETRY_DELAY, null, null,
      hitchHandler(this, "failureNotification"))
  );
    
  submit.perform(this.redditModHash, linkInfo.id, linkInfo.uiState.isLiked);
};

Socialite.buttonCommentsClicked = function(linkInfo, e) {
  openUILink(linkInfo.commentURL, e);
};

Socialite.buttonSaveClicked = function(linkInfo, e) {
  if (linkInfo.uiState.isSaved) {
    
    linkInfo.uiState.isSaved = false;
    linkInfo.uiState.updated();
    this.updateSaveButton(linkInfo.buttons, linkInfo.uiState.isSaved);

    (new reddit.unsave(
      hitchHandler(this, "redditUpdateLinkInfo", linkInfo),
      retryAction(RETRY_COUNT, RETRY_DELAY, null, null,
        hitchHandler(this, "failureNotification"))
    )).perform(this.redditModHash, linkInfo.id);
        
  } else {
  
    linkInfo.uiState.isSaved = true;
    linkInfo.uiState.updated();   
    this.updateSaveButton(linkInfo.buttons, linkInfo.uiState.isSaved);

    (new reddit.save(
      hitchHandler(this, "redditUpdateLinkInfo", linkInfo),
      retryAction(RETRY_COUNT, RETRY_DELAY, null, null,
        hitchHandler(this, "failureNotification"))
    )).perform(this.redditModHash, linkInfo.id);
  }
};

Socialite.buttonRandomClicked = function(e) {
  var self = this;

  (new reddit.randomrising(
    function (r, json) {
      var linkInfo = LinkInfoFromJSON(json);
      self.watchLink(linkInfo.url, linkInfo);
      openUILink(linkInfo.url, e);
    },
    retryAction(RETRY_COUNT, RETRY_DELAY, null, null,
      hitchHandler(this, "failureNotification"))
  )).perform();
};


Socialite.siteLinkClicked = function(e) {
  openUILink("http://www.reddit.com", e);
};

Socialite.init();
